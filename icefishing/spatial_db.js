const SpatialSyncDB = {
    CHUNK_SIZE: 800,       // 20 tiles wide
    collections: {},       // The actual wrapped data e.g. npcs: Proxy([...])
    rawCollections: {},    // The underlying objects
    players: {},           // Track where clients are: { peerId: { x, y, lastInput: {} } }
    dirtyPatches: {},      // Accumulates changes: collection -> entityId -> prop -> val
    _isApplyingPatch: false, // Prevents infinite loops when receiving updates

    // Used by Host to generate ID for an entity
    generateId() {
        return Math.random().toString(36).substr(2, 9);
    },

    initAsHost() {
        this.collections = {};
        this.rawCollections = {};
        this.dirtyPatches = {};
        this.players = this.createCollection('players', [{ id: Network.myId, x: 0, y: 0, active: true, facing: 1, state: 'idle' }]);
    },

    initAsClient() {
        this.collections = {};
        this.rawCollections = {};
        this.dirtyPatches = {};
        this.players = this.createCollection('players', []);
    },

    createCollection(name, initialData) {
        // Ensure each entity has an ID
        const normalizedData = {};
        if (Array.isArray(initialData)) {
            for (let i = 0; i < initialData.length; i++) {
                let entity = initialData[i];
                if (!entity.id) entity.id = this.generateId();
                normalizedData[entity.id] = entity;
            }
        } else {
            for (const id in initialData) {
                if (!initialData[id].id) initialData[id].id = id;
                normalizedData[id] = initialData[id];
            }
        }

        this.rawCollections[name] = normalizedData;
        this.dirtyPatches[name] = {};

        // Wrap the collection to automatically track changes
        // Since Game code does things like NPCs.entities[i].x += 10, replacing array with an object map
        // means we need to expose an array-like interface or refactor game to use ID maps.
        // We'll expose an array of wrapped entities if they want to iterate, but writes go through proxies.

        // Wait, game iterates like \`for (let i=0; i<npcs.length; i++)\`.
        // To keep game logic unchanged, we keep it an array, but the array contents are Proxy objects.
        const arr = [];
        for (const id in normalizedData) {
            arr.push(this._createEntityProxy(name, normalizedData[id]));
        }

        // Wrap the array itself to track additions/removals
        this.collections[name] = new Proxy(arr, {
            get: (target, prop) => {
                if (prop === 'push') {
                    return (newEntity) => {
                        if (!newEntity.id) newEntity.id = this.generateId();
                        this.rawCollections[name][newEntity.id] = newEntity;
                        const proxy = this._createEntityProxy(name, newEntity);
                        target.push(proxy);
                        if (Network.isHost) {
                            this._markDirty(name, newEntity.id, '__add', newEntity);
                        } else if (!this._isApplyingPatch) {
                            Network.sendToHost({ type: 'action', actionType: 'add', collection: name, entity: newEntity });
                        }
                        return proxy;
                    };
                }
                if (prop === 'splice') {
                    return (start, deleteCount, ...items) => {
                        const removed = target.slice(start, start + deleteCount);
                        for (const r of removed) {
                            delete this.rawCollections[name][r.id];
                            if (Network.isHost) {
                                this._markDirty(name, r.id, '__remove', true);
                            } else if (!this._isApplyingPatch) {
                                Network.sendToHost({ type: 'action', actionType: 'remove', collection: name, id: r.id });
                            }
                        }
                        return target.splice(start, deleteCount);
                    };
                }
                return target[prop];
            },
            set: (target, prop, value) => {
                target[prop] = value;
                return true;
            }
        });

        return this.collections[name];
    },

    _createEntityProxy(collectionName, entityObj) {
        return new Proxy(entityObj, {
            set: (target, prop, value) => {
                if (target[prop] !== value) {
                    target[prop] = value;
                    if (Network.isHost) {
                        this._markDirty(collectionName, target.id, prop, value);
                    } else if (!this._isApplyingPatch) {
                        Network.sendToHost({ type: 'action', actionType: 'update', collection: collectionName, id: target.id, prop: prop, value: value });
                    }
                }
                return true;
            }
        });
    },

    _markDirty(collection, id, prop, value) {
        if (!this.dirtyPatches[collection][id]) {
            this.dirtyPatches[collection][id] = {};
        }
        this.dirtyPatches[collection][id][prop] = value;
    },

    getChunkFromX(x) {
        return Math.floor(x / this.CHUNK_SIZE);
    },

    // Every tick, compile patches to send to clients based on what chunks they can see
    compileAndBroadcastPatches() {
        if (!Network.isHost) return;

        const chunksByPlayer = {};
        const allClientIds = Network.connections.map(c => c.peer);

        if (allClientIds.length === 0) {
            // No clients, just clear patches
            for (const c in this.dirtyPatches) this.dirtyPatches[c] = {};
            return;
        }

        // 1. Determine which chunks each player is interested in
        for (const clientId of allClientIds) {
            const p = this.players.find(curr => curr.id === clientId);
            if (!p) continue;

            const centerChunk = this.getChunkFromX(p.x || 0);

            // Send patches for chunk they are in + 3 chunks left and right (e.g. 5600px total view radius)
            // Adjust depending on how wide the screen is
            chunksByPlayer[clientId] = new Set([
                centerChunk - 3, centerChunk - 2, centerChunk - 1,
                centerChunk, centerChunk + 1, centerChunk + 2, centerChunk + 3
            ]);
        }

        // 2. Build personalized patch arrays for each client
        const playerPayloads = {};
        for (const clientId of allClientIds) {
            playerPayloads[clientId] = [];
        }

        for (const colName in this.dirtyPatches) {
            for (const entityId in this.dirtyPatches[colName]) {
                const patch = this.dirtyPatches[colName][entityId];

                // Get spatial location of this entity to determine chunk
                let entity = this.rawCollections[colName][entityId];

                // If it was removed, it has no entity, we broadcast to everyone just in case
                let chunk = null;
                if (entity && entity.x !== undefined) {
                    chunk = this.getChunkFromX(entity.x);
                }

                const packedPatch = [colName, entityId, patch];

                // Distribute
                for (const clientId of allClientIds) {
                    if (chunk === null || (chunksByPlayer[clientId] && chunksByPlayer[clientId].has(chunk))) {
                        playerPayloads[clientId].push(packedPatch);
                    }
                }
            }
            // Clear dirty after generating payloads
            this.dirtyPatches[colName] = {};
        }

        // Send to clients
        Network.broadcastState(playerPayloads);
    },

    // Apply received patches on Client
    applyPatches(patches) {
        this._isApplyingPatch = true;
        for (let i = 0; i < patches.length; i++) {
            const [collection, id, changes] = patches[i];

            if (!this.collections[collection]) continue;

            const arr = this.collections[collection];
            let existingIdx = arr.findIndex(e => e.id === id);

            if (changes['__remove']) {
                if (existingIdx >= 0) arr.splice(existingIdx, 1);
                continue;
            }

            if (changes['__add']) {
                if (existingIdx < 0) {
                    arr.push(changes['__add']); // Because Proxy handles 'push', it creates proxy automatically
                } else {
                    Object.assign(arr[existingIdx], changes['__add']);
                }
                continue;
            }

            if (existingIdx >= 0) {
                // We use raw inner object assignment carefully or just assign properties to proxy
                for (const prop in changes) {
                    arr[existingIdx][prop] = changes[prop];
                }
            } else {
                // We received patch for entity we don't have yet, might happen if joining mid-game or it walked into chunk
                // We should technically request full state, or if UI is loose, we inject it.
                // Assuming changes contains minimally 'x', 'type' we inject
                if (changes.type || changes.x !== undefined) {
                    // Add partial entity
                    const newEnt = { id: id, ...changes };
                    arr.push(newEnt);
                }
            }
        }
        this._isApplyingPatch = false;
    },

    addPlayer(id) {
        if (!this.players) return;
        if (!this.players.find(p => p.id === id)) {
            this.players.push({ id: id, x: 0, y: 0, active: true, facing: 1, state: 'idle' });
        }
    },

    removePlayer(id) {
        if (!this.players) return;
        const index = this.players.findIndex(p => p.id === id);
        if (index >= 0) {
            this.players.splice(index, 1);
        }
    },

    updateRemotePlayer(id, data) {
        if (!this.players) return;
        const p = this.players.find(p => p.id === id);
        if (p) {
            p.x = data.x;
            p.y = data.y;
            p.facing = data.facing;
            p.state = data.state;
            p.actionTimer = data.actionTimer;
            p.animFrame = data.animFrame;
            p.handItem = data.handItem;
            p.secondHand = data.secondHand;
        }
    },

    handleClientAction(clientId, data) {
        if (!this.isHost) return;
        const col = this.collections[data.collection];
        if (!col) return;

        if (data.actionType === 'update') {
            const entity = col.find(e => e.id === data.id);
            if (entity) {
                entity[data.prop] = data.value;
            }
        } else if (data.actionType === 'remove') {
            const idx = col.findIndex(e => e.id === data.id);
            if (idx >= 0) {
                col.splice(idx, 1);
            }
        } else if (data.actionType === 'add') {
            const exists = col.find(e => e.id === data.entity.id);
            if (!exists) {
                col.push(data.entity);
            }
        }
    }
};
