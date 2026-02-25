import * as THREE from 'three';

// Path loss exponent for free space
const PATH_LOSS_EXPONENT = 2.0;
// Reference RSSI at 1 meter (depends on device/transmitter, standard approximation)
const TX_POWER_WIFI = -45; // Simulated Wi-Fi
const TX_POWER_BLE = -59;  // Standard BLE reference

export class SignalScanner {
    constructor(scene, camera, overlayContainer) {
        this.scene = scene;
        this.camera = camera;
        this.overlayContainer = overlayContainer;

        // Map of device UUID -> SignalSource object
        this.sources = new Map();

        // 3D group to hold all signal markers
        this.markersGroup = new THREE.Group();
        this.scene.add(this.markersGroup);

        // Parameters for triangulation
        this.minSamplesForTriangulation = 5; // Need at least 5 samples to estimate properly
        this.maxSamplesPerSource = 50;

        // Mock Wi-Fi for testing
        this.mockWifiActive = true;
        this.mockWifiSources = [
            { id: "mock-wifi-1", name: "Guest Wi-Fi", position: new THREE.Vector3(2, 1, -3), txPower: TX_POWER_WIFI },
            { id: "mock-wifi-2", name: "Office Network", position: new THREE.Vector3(-3, 0.5, -2), txPower: TX_POWER_WIFI }
        ];

        this.lastSampleTime = 0;
        this.sampleIntervalMs = 500; // Collect mock samples twice a second

        // Setup Bluetooth scanning if supported
        this.initBluetooth();
    }

    async initBluetooth() {
        if (navigator.bluetooth && navigator.bluetooth.requestLEScan) {
            try {
                // Requires chrome://flags/#enable-experimental-web-platform-features
                const scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true });
                navigator.bluetooth.addEventListener('advertisementreceived', (event) => {
                    if (this.isActive) {
                        this.addSample(
                            event.device.id,
                            event.device.name || "Unknown BLE Device",
                            event.rssi,
                            TX_POWER_BLE,
                            this.camera.position.clone()
                        );
                    }
                });
                console.log("BLE Scan started.");
            } catch (err) {
                console.warn("BLE scanning not available. Using mock Wi-Fi only.", err);
            }
        }
    }

    // Toggle scanning (called from UI)
    setActive(active) {
        this.isActive = active;
        this.markersGroup.visible = active;
        for (const source of this.sources.values()) {
            if (source.labelElement) {
                source.labelElement.style.display = active ? 'block' : 'none';
            }
        }
    }

    // Estimate distance from RSSI
    estimateDistance(rssi, txPower) {
        return Math.pow(10, (txPower - rssi) / (10 * PATH_LOSS_EXPONENT));
    }

    addSample(id, name, rssi, txPower, cameraPosition) {
        if (!this.sources.has(id)) {
            // Pick a random color for this source marker
            const color = new THREE.Color().setHSL(Math.random(), 1.0, 0.5);

            // Create DOM label
            const label = document.createElement('div');
            label.className = 'signal-label';
            label.style.position = 'absolute';
            label.style.padding = '4px 8px';
            label.style.background = 'rgba(0, 0, 0, 0.7)';
            label.style.color = '#' + color.getHexString();
            label.style.borderRadius = '4px';
            label.style.fontSize = '12px';
            label.style.fontFamily = 'monospace';
            label.style.pointerEvents = 'none';
            label.style.border = `1px solid #${color.getHexString()}`;
            label.style.transform = 'translate(-50%, -50%)'; // Center on point
            label.style.zIndex = '1000';
            label.style.display = this.isActive ? 'block' : 'none';
            this.overlayContainer.appendChild(label);

            // Create 3D marker geometry (a small sphere or beacon)
            const geometry = new THREE.SphereGeometry(0.1, 16, 16);
            const material = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.8 });
            const marker = new THREE.Mesh(geometry, material);
            marker.visible = false; // Hide until triangulated
            this.markersGroup.add(marker);

            this.sources.set(id, {
                id,
                name,
                txPower,
                color,
                samples: [],
                estimatedPosition: null,
                labelElement: label,
                markerMesh: marker,
                lastRssi: rssi
            });
        }

        const source = this.sources.get(id);
        const distance = this.estimateDistance(rssi, txPower);

        // Add to history (FIFO)
        source.samples.push({
            position: cameraPosition.clone(),
            rssi: rssi,
            distance: distance,
            time: performance.now()
        });

        source.lastRssi = rssi;

        if (source.samples.length > this.maxSamplesPerSource) {
            source.samples.shift();
        }

        // Try to update Triangulation
        if (source.samples.length >= this.minSamplesForTriangulation) {
            this.triangulateSource(source);
        }
    }

    triangulateSource(source) {
        // Simple 3D trilateration using Gradient Descent or Weighted Average
        // Since pure trilateration is noisy, we use a weighted centroid approach with outlier rejection.

        let validSamples = source.samples.slice();

        // 1. Remove Outliers (basic statistical filtering)
        if (validSamples.length >= 8) {
            // Find median distance
            validSamples.sort((a, b) => a.distance - b.distance);
            const medianDist = validSamples[Math.floor(validSamples.length / 2)].distance;

            // Filter samples that are unrealistically far/close compared to median
            validSamples = validSamples.filter(s =>
                s.distance >= medianDist * 0.3 && s.distance <= medianDist * 2.5
            );
        }

        if (validSamples.length < 3) return; // Not enough good samples

        // 2. Estimate position
        // A simple heuristic: The source is likely near the positions where RSSI is strongest.
        // We calculate a weighted centroid of the sample positions, extending outward by the estimated distance
        // in the direction of the camera's assumed looking angle... Wait, RSSI is omnidirectional.
        // Better heuristic: Use a grid search or Center of Gravity (CoG) based on signal strength.

        // Let's use a Weighted Centroid based on proximity (1 / distance) for a rough estimate.
        // For true trilateration, a least-squares optimization is needed, which runs iteratively.
        // We'll approximate a quick position:

        // Find the sample with the strongest signal (closest)
        let bestSample = validSamples[0];
        for (const s of validSamples) {
            if (s.rssi > bestSample.rssi) bestSample = s;
        }

        // Initial guess: the position of the strongest sample
        let guess = bestSample.position.clone();

        // Refine using simple iterative Gradient Descent minimizing error = sum((dist(guess, sample.pos) - sample.distance)^2)
        const learningRate = 0.05;
        const iterations = 50;

        for (let iter = 0; iter < iterations; iter++) {
            let gradient = new THREE.Vector3(0, 0, 0);
            for (const s of validSamples) {
                const diff = new THREE.Vector3().subVectors(guess, s.position);
                const currentDist = diff.length();
                if (currentDist > 0.001) {
                    const error = currentDist - s.distance;
                    diff.normalize().multiplyScalar(error * 2); // Derivative of error^2
                    gradient.add(diff);
                }
            }
            gradient.divideScalar(validSamples.length);
            guess.sub(gradient.multiplyScalar(learningRate));
        }

        // Apply some smoothing to avoid jumping around too much
        if (source.estimatedPosition) {
            source.estimatedPosition.lerp(guess, 0.4);
        } else {
            source.estimatedPosition = guess;
        }

        // Update 3D Marker
        source.markerMesh.position.copy(source.estimatedPosition);
        source.markerMesh.visible = true;
    }

    update(time, camera) {
        if (!this.isActive) return;

        // Generate mock Wi-Fi samples periodically
        if (this.mockWifiActive && time - this.lastSampleTime > this.sampleIntervalMs) {
            this.lastSampleTime = time;
            for (const mockSrc of this.mockWifiSources) {
                // Add some noise to the RSSI based on true distance
                const trueDist = camera.position.distanceTo(mockSrc.position);
                // Math.pow(10, (txPower - rssi) / 20) = distance => rssi = txPower - 20 * log10(distance)
                const idealRssi = mockSrc.txPower - 10 * PATH_LOSS_EXPONENT * Math.log10(Math.max(0.1, trueDist));
                // Add +/- 5 dBm noise
                const noisyRssi = idealRssi + (Math.random() * 10 - 5);

                this.addSample(
                    mockSrc.id,
                    mockSrc.name,
                    noisyRssi,
                    mockSrc.txPower,
                    camera.position
                );
            }
        }

        // Update 2D labels position on screen
        const halfWidth = window.innerWidth / 2;
        const halfHeight = window.innerHeight / 2;
        const tempV = new THREE.Vector3();

        for (const source of this.sources.values()) {
            if (source.estimatedPosition && source.markerMesh.visible) {
                tempV.copy(source.estimatedPosition);

                // Project 3D position to 2D screen coordinate
                tempV.project(camera);

                // Check if behind camera
                if (tempV.z > 1) {
                    source.labelElement.style.display = 'none';
                    continue;
                }

                const x = (tempV.x * halfWidth) + halfWidth;
                const y = -(tempV.y * halfHeight) + halfHeight;

                source.labelElement.style.display = 'block';
                source.labelElement.style.left = `${x}px`;
                source.labelElement.style.top = `${y}px`;

                // Calculate distance from camera to estimated position
                const distFromCam = camera.position.distanceTo(source.estimatedPosition);

                // Update text content
                source.labelElement.innerHTML = `
                    <strong>${source.name}</strong><br>
                    ID: ${source.id}<br>
                    Dist: ${distFromCam.toFixed(2)}m<br>
                    RSSI: ${source.lastRssi.toFixed(1)} dBm
                `;
            } else {
                source.labelElement.style.display = 'none';
            }
        }
    }

    cleanup() {
        // Remove markers
        if (this.markersGroup) {
            this.scene.remove(this.markersGroup);
        }
        // Remove DOM labels
        for (const source of this.sources.values()) {
            if (source.labelElement && source.labelElement.parentNode) {
                source.labelElement.parentNode.removeChild(source.labelElement);
            }
        }
        this.sources.clear();
    }
}
