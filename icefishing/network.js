const Network = {
    peer: null,
    connections: [],
    hostConnection: null,
    isHost: false,
    isClient: false,
    myId: null,
    lobbyId: null,
    statusEl: null,
    tickWorker: null,
    tickInterval: 1000 / 60,

    // Background worker as a blob URL to tick game when tabbed out
    initWorker() {
        const workerCode = `
            let timerId;
            self.onmessage = function(e) {
                if (e.data.command === 'start') {
                    const interval = e.data.interval || 1000/60;
                    if (timerId) clearInterval(timerId);
                    timerId = setInterval(() => self.postMessage('tick'), interval);
                } else if (e.data.command === 'stop') {
                    clearInterval(timerId);
                    timerId = null;
                }
            };
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this.tickWorker = new Worker(URL.createObjectURL(blob));
        this.tickWorker.onmessage = () => {
            // Trigger game loop directly when receiving worker tick
            if (Game.running && !this.isClient) {
                Game.loop(performance.now(), true);
            }
        };
    },

    startWorker() {
        if (!this.tickWorker) this.initWorker();
        this.tickWorker.postMessage({ command: 'start', interval: this.tickInterval });
    },

    stopWorker() {
        if (this.tickWorker) {
            this.tickWorker.postMessage({ command: 'stop' });
        }
    },

    setStatus(msg) {
        if (!this.statusEl) this.statusEl = document.getElementById('network-status');
        if (this.statusEl) this.statusEl.innerText = msg;
        console.log("Network:", msg);
    },

    startSolo() {
        this.isHost = true;
        this.isClient = false;
        this.myId = 'solo';
        SpatialSyncDB.initAsHost();
        this.startWorker();
        Game.init();
    },

    autoJoin() {
        const urlParams = new URLSearchParams(window.location.search);
        const lobbyParam = urlParams.get('lobby');
        if (lobbyParam) {
            document.getElementById('join-id').value = lobbyParam;
            this.joinGame(lobbyParam);
        }
    },

    hostGame() {
        this.setStatus("Initializing Host...");
        this.peer = new Peer({
            debug: 2
        });

        this.peer.on('open', (id) => {
            this.myId = id;
            this.lobbyId = id;
            this.isHost = true;
            this.isClient = false;
            this.setStatus(`Lobby ID: ${id} (Share this!)`);

            // modify URL without reloading
            const url = new URL(window.location);
            url.searchParams.set('lobby', id);
            window.history.pushState({}, '', url);

            SpatialSyncDB.initAsHost();
            this.startWorker();

            Game.init();
        });

        this.peer.on('connection', (conn) => {
            this.setStatus(`Client connecting: ${conn.peer}`);

            conn.on('open', () => {
                this.connections.push(conn);
                this.setStatus(`Client joined: ${conn.peer}`);

                // Initialize player in the database
                SpatialSyncDB.addPlayer(conn.peer);

                // Send world configuration
                conn.send({ type: 'global', event: 'init', data: { seed: World.seed } });

                conn.on('data', (data) => {
                    this.handleClientData(conn.peer, data);
                });
            });

            conn.on('close', () => {
                this.setStatus(`Client left: ${conn.peer}`);
                this.connections = this.connections.filter(c => c.peer !== conn.peer);
                SpatialSyncDB.removePlayer(conn.peer);
            });
        });

        this.peer.on('error', (err) => {
            this.setStatus("Host Error: " + err.type);
            console.error(err);
        });
    },

    joinGame(lobbyParamsId = null) {
        const joinId = lobbyParamsId || document.getElementById('join-id').value.trim();
        if (!joinId) {
            this.setStatus("Please enter a Lobby ID.");
            return;
        }

        this.setStatus("Connecting to Host...");
        this.peer = new Peer({
            debug: 2
        });

        this.peer.on('open', (id) => {
            this.myId = id;
            this.isHost = false;
            this.isClient = true;

            this.hostConnection = this.peer.connect(joinId, {
                reliable: false // For game state UDP/WebRTC data channel is fine
            });

            this.hostConnection.on('open', () => {
                this.setStatus("Connected to Host! Waiting for map...");
                SpatialSyncDB.initAsClient();
                // Game.init() is now called when we receive the 'init' global event

                this.hostConnection.on('data', (data) => {
                    this.handleHostData(data);
                });
            });

            this.hostConnection.on('close', () => {
                this.setStatus("Disconnected from Host.");
                if (Game.running) {
                    Game.gameOver = true;
                    Game.showMessage("Host disconnected.", 5);
                }
            });

            this.hostConnection.on('error', (err) => {
                this.setStatus("Connection Error.");
                console.error(err);
            });
        });

        this.peer.on('error', (err) => {
            this.setStatus("Join Error: " + err.type);
            console.error(err);
        });
    },

    broadcastState(patches) {
        if (!this.isHost) return;
        // The host iterates through connections, and sends them only the patches they need
        // SpatialSyncDB already pre-calculated which patches go to which player

        for (const conn of this.connections) {
            const playerPatches = patches[conn.peer];
            if (playerPatches && playerPatches.length > 0) {
                conn.send({ type: 'sync', patches: playerPatches });
            }
        }
    },

    broadcastGlobal(eventName, data) {
        if (!this.isHost) return;
        const msg = { type: 'global', event: eventName, data: data };
        for (const conn of this.connections) {
            conn.send(msg);
        }
    },

    sendToHost(data) {
        if (!this.isClient || !this.hostConnection) return;
        this.hostConnection.send(data);
    },

    handleClientData(clientId, data) {
        if (!this.isHost) return;
        // Data from client to host (e.g., input, position, actions)
        if (data.type === 'input') {
            SpatialSyncDB.updateRemotePlayer(clientId, data);
        } else if (data.type === 'action') {
            SpatialSyncDB.handleClientAction(clientId, data);
        }
    },

    handleHostData(data) {
        if (!this.isClient) return;
        // Data from host to client
        if (data.type === 'sync') {
            SpatialSyncDB.applyPatches(data.patches);
        } else if (data.type === 'global') {
            // e.g., config, Set time of day, weather change
            if (data.event === 'init') {
                World.seed = data.data.seed;
                Game.init();
            } else if (data.event === 'time') {
                Survival.timeOfDay = data.data.timeOfDay;
                Survival.dayCount = data.data.dayCount;
            } else if (data.event === 'weather') {
                Survival.stormActive = data.data.stormActive;
                if (data.data.stormActive) {
                    Survival.stormIntensity = data.data.stormIntensity;
                    if (!Survival.stormActive) { // If it wasn't active
                        Game.showMessage('A snowstorm is coming!', 3);
                    }
                } else {
                    Survival.stormIntensity = 0;
                    if (Survival.stormActive) { // If it was active
                        Game.showMessage('The storm has passed.', 2);
                    }
                }
            }
        }
    }
};
