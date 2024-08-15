/*
  Copyright: (c) 2022, ST-One
  GNU General Public License v3.0+ (see LICENSE or https://www.gnu.org/licenses/gpl-3.0.txt)
*/

try{
    var BnR = require('@protocols/node-bnr').INACpu
    var {itemGroup} = require('@protocols/node-bnr')
    var fs = require('fs');
}catch(error){
    var BnR = null;
    var itemGroup = null;
};
    

const MIN_CYCLE_TIME = 500;

module.exports = function (RED) {
  // Escuta o evento `nodes-ready` para emitir uma mensagem no debug

    // ----------- BnR Endpoint -----------
    function generateStatus(status, val) {
        var obj;
        if (typeof val != 'string' && typeof val != 'number' && typeof val != 'boolean') {
            val = RED._('bnr.endpoint.status.online');
        }
        switch (status) {
            case 'online':
                obj = {
                    fill: 'green',
                    shape: 'dot',
                    text: val.toString()
                };
                break;
            case 'offline':
                obj = {
                    fill: 'red',
                    shape: 'dot',
                    text: RED._('bnr.endpoint.status.offline')
                };
                break;
            case 'connecting':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._('bnr.endpoint.status.connecting')
                };
                break;
            default:
                obj = {
                    fill: 'grey',
                    shape: 'dot',
                    text: RED._('bnr.endpoint.status.unknown')
                };
        }
        return obj;
    }

    function createTranslationTable(vars) {
        var res = {};

        vars.forEach(function (elm) {
            if (!elm.name || !elm.addr) {
                //skip incomplete entries
                return;
            }
            
            res[elm.name] = elm.addr;
        });

        return res;
    }

    function equals(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return false;
        if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length != b.length) return false;
    
            for (var i = 0; i < a.length; ++i) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }
        return false;
    }

    function nrInputShim(node, fn) {
        node.on('input', function (msg, send, done) {
            send = send || node.send;
            done = done || (err => err && node.error(err, msg));
            fn(msg, send, done);
        });
    }

        async function getAllVariables(inacpu, res) {
            let intervalId;
            let timedOut = false;

            console.log('Waiting for connection...')
            const sendWaitingMessage = () => {
                console.log('Still waiting for connection...')
            };
            
            // Sends 'connecting' message periodically, while not connected
            intervalId = setInterval(sendWaitingMessage, 5000);
     

            inacpu.on('error', (e) => {
                    clearInterval(intervalId);
                    console.log(`ERROR: ${e}`)
            });

            inacpu.on('timeout',  async () => {
                    clearInterval(intervalId);
                    inacpu.removeAllListeners();
                    console.log('Connection timeout')
                    inacpu.disconnect();
                    inacpu.destroy();
                    res.status(500).end();
            });

            inacpu.on('disconnected', () => {
                clearInterval(intervalId);
                console.log("Finished and Disconnected")
            });
        
           inacpu.on('connected', async () => {
                    clearInterval(intervalId);
                   console.log('Connected, getting variable list...')
                     try {
                                let hasData = false;
                                res.attachment('varList.csv');
                                res.write('Variable\n'); // CSV headers
                                for await (const elm of inacpu.getVariableListGenerator()) {
                                    // Ensure each variable is formatted in a separated line in csv
                                    res.write(`${elm}\n`);
                                    hasData = true;
                                }
                
                                console.log('CSV download complete');
                                if (!hasData) {
                                    console.warn('No data was written to the CSV.');
                                    res.status(204).end('No content');
                                } else {
                                 console.log('download csv')
                                    res.end();
                                }
                           
                        } catch (e) {
                                res.status(500).end();
                                console.log(`Error retrieving variables: ${e.message}`)
                        }                    

                        finally {
                            await inacpu.disconnect();
                            await inacpu.destroy();
                        }

                })     
                try {
                     await inacpu.connect();
                  
                } catch (e) {
                        clearInterval(intervalId);
                        console.log(`Connection failed: ${e.message}`)
                        res.status(500).end();
                }
    }

    RED.httpAdmin.get('/__node-red-contrib-bnr/getallvar', async function (req, res) {
        const { port, ip, sa, timeout,cycletime } = req.query;
        if (!ip||!sa||!port||!timeout){
            console.log("Error: Missing parameter for connection")
            res.status(500).send();
       } 
       //creates new instance for connection
       var inacpu = new BnR(ip, {sa, port, timeout});
       if (!inacpu){
           console.log("Error: Unable to create instance for connection")
           res.status(500).send();
       }
       try {
           await getAllVariables(inacpu,res);
       } catch (e) {
           console.log("Error: ${e.message}")
           res.status(500).send();
       }
    });

    // <Begin> --- Endpoint ---
    function BNREndpoint(config) {
        let oldValues = {};
        let readInProgress = false;
        let readDeferred = 0;
        let currentCycleTime = config.cycletime;
        let address = config.ip
        let port = config.port
        let timeout = config.timeout
        let sa = config.sa
        let _cycleInterval;
        let _reconnectTimeout = null;
        let connected = false;
        let status;
        let that = this;
        let bnr = null;
        let addressGroup = null;
        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of bnr In nodes
        this.setMaxListeners(0);

        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            that.emit('__STATUS__', status);
        }

        function doCycle() {
            if (!readInProgress && connected) {
                readInProgress = true;
                
                addressGroup.readAllitems()
                .then(result => {
                    cycleCallback(result);
                })
                .catch(error => {
                    onError(error);
                    readInProgress = false;
                });

            } else {
                readDeferred++;
            }
        }

        function cycleCallback(values) {
            readInProgress = false;

            if (readDeferred && connected) {
                doCycle();
                readDeferred = 0;
            }

            manageStatus('online');

            var changed = false;
            that.emit('__ALL__', values);
            Object.keys(values).forEach(function (key) {
                if (!equals(oldValues[key], values[key])) {
                    changed = true;
                    that.emit(key, values[key]);
                    that.emit('__CHANGED__', {
                        key: key,
                        value: values[key]
                    });
                    oldValues[key] = values[key];
                }
            });
            if (changed) that.emit('__ALL_CHANGED__', values);
        }

        function updateCycleTime(interval) {
            let time = parseInt(interval);

            if (isNaN(time) || time < 0) {
                that.error(RED._("bnr.endpoint.error.invalidtimeinterval", { interval: interval }));
                return false
            }

            clearInterval(_cycleInterval);

            // don't set a new timer if value is zero
            if (!time) return false;

            if (time < MIN_CYCLE_TIME) {
                that.warn(RED._("bnr.endpoint.info.cycletimetooshort", { min: MIN_CYCLE_TIME }));
                time = MIN_CYCLE_TIME;
            } 

            currentCycleTime = time;
            _cycleInterval = setInterval(doCycle, time);

            return true;
        }

        function removeListeners() {
             if (bnr !== null) {
                bnr.removeListener('connected', onConnect);
                bnr.removeListener('disconnected', onDisconnect);
                bnr.removeListener('error', onError);
                bnr.removeListener('timeout', onTimeout);
             }
        }

        /**
         * Destroys the bnr connection
         * @param {Boolean} [reconnect=true]  
         * @returns {Promise}
         */
        async function disconnect(reconnect = true) {
            // if (!connected) return;
            connected = false;

            clearInterval(_cycleInterval);
            _cycleInterval = null;

            if (bnr) {
                if (!reconnect) bnr.removeListener('disconnected', onDisconnect);
                bnr.destroy().
                then(() => {
                    removeListeners();
                    bnr = null;
                }).catch(err => onError(err));
                
            }

            console.log("Endpoint - disconnect");
        }

        
        async function connect() {
            
            if (!BnR || !itemGroup) return that.error('Missing "@protocols/node-bnr" dependency, avaliable only on the ST-One hardware. Please contact us at "st-one.io" for pricing and more information.')

            manageStatus('connecting');
            
            if (_reconnectTimeout !== null) {
                clearTimeout(_reconnectTimeout);
                _reconnectTimeout = null;
            }
            
            if (bnr !== null) {
                await disconnect();
            }
            
            bnr = new BnR(address, {sa, port, timeout});
        
            bnr.on('connected', onConnect);
            bnr.on('disconnected', onDisconnect);
            bnr.on('error', onError);
            bnr.on('timeout', onTimeout);

            bnr.connect()
        }

        function onConnect() {
            readInProgress = false;
            readDeferred = 0;
            connected = true;

            addressGroup = new itemGroup(bnr);

            manageStatus('online');

            let _vars = createTranslationTable(config.vartable);

            addressGroup.setTranslationCB(k => _vars[k]);
            let varKeys = Object.keys(_vars);

            if (!varKeys || !varKeys.length) {
                that.warn(RED._("bnr.endpoint.info.novars"));
            } else {
                addressGroup.addItems(varKeys);
                updateCycleTime(currentCycleTime);
            }
        }

        function onDisconnect() {

            manageStatus('offline');
            if (!_reconnectTimeout) {
                _reconnectTimeout = setTimeout(connect, 4000);
            }
        }

        function onError(e) {
            manageStatus('offline');
            that.error(e && e.toString());
            disconnect();
        }

        function onTimeout(e) {
            manageStatus('offline');
            that.error(e && e.toString());
            disconnect();
        }

        function getStatus() {
            that.emit('__STATUS__', status);
        }

        function updateCycleEvent(obj) {
            obj.err = updateCycleTime(obj.msg.payload);
            that.emit('__UPDATE_CYCLE_RES__', obj);
        }

        manageStatus('offline');

        this.on('__DO_CYCLE__', doCycle);
        this.on('__UPDATE_CYCLE__', updateCycleEvent);
        this.on('__GET_STATUS__', getStatus);

        connect();

        this.on('close', done => {
            manageStatus('offline');
            clearInterval(_cycleInterval);
            clearTimeout(_reconnectTimeout);
            _cycleInterval = null
            _reconnectTimeout = null;
            
            that.removeListener('__DO_CYCLE__', doCycle);
            that.removeListener('__UPDATE_CYCLE__', updateCycleEvent);
            that.removeListener('__GET_STATUS__', getStatus);           

            disconnect(false)
            .then(done)
            .catch(err => onError(err))//TODO:

            console.log("Endpoint - on close!");
        });
        
    }

    RED.nodes.registerType('bnr endpoint', BNREndpoint);
    // <End> --- Endpoint

    // <Begin> --- BnR In
    function BNRIn(config) {
        RED.nodes.createNode(this, config);
        let statusVal;
        let that = this

        let endpoint = RED.nodes.getNode(config.endpoint);

        if (!endpoint) {
            that.error(RED._("bnr.error.missingconfig"));
            return;
        }

        function sendMsg(data, key, status) {
            if (key === undefined) key = '';
            if (data instanceof Date) data = data.getTime();
            var msg = {
                payload: data,
                topic: key
            };
            statusVal = status !== undefined ? status : data;
            that.send(msg);
            endpoint.emit('__GET_STATUS__');
        }
        
        function onChanged(variable) {
            sendMsg(variable.value, variable.key, null);
        }

        function onDataSplit(data) {
            Object.keys(data).forEach(function (key) {
                sendMsg(data[key], key, null);
            });
        }

        function onData(data) {
            sendMsg(data, config.mode == 'single' ? config.variable : '');
        }

        function onDataSelect(data) {
            onData(data[config.variable]);
        }

        function onEndpointStatus(status) {
            that.status(generateStatus(status, statusVal));
        }
        
        endpoint.on('__STATUS__', onEndpointStatus);
        endpoint.emit('__GET_STATUS__');

        if (config.diff) {
            switch (config.mode) {
                case 'all-split':
                    endpoint.on('__CHANGED__', onChanged);
                    break;
                case 'single':
                    endpoint.on(config.variable, onData);
                    break;
                case 'all':
                default:
                    endpoint.on('__ALL_CHANGED__', onData);
            }
        } else {
            switch (config.mode) {
                case 'all-split':
                    endpoint.on('__ALL__', onDataSplit);
                    break;
                case 'single':
                    endpoint.on('__ALL__', onDataSelect);
                    break;
                case 'all':
                default:
                    endpoint.on('__ALL__', onData);
            }
        }

        this.on('close', function (done) {
            endpoint.removeListener('__ALL__', onDataSelect);
            endpoint.removeListener('__ALL__', onDataSplit);
            endpoint.removeListener('__ALL__', onData);
            endpoint.removeListener('__ALL_CHANGED__', onData);
            endpoint.removeListener('__CHANGED__', onChanged);
            endpoint.removeListener('__STATUS__', onEndpointStatus);
            endpoint.removeListener(config.variable, onData);
            done();
        });

    }

    RED.nodes.registerType('bnr in', BNRIn);
    // <End> --- BnR In

    // <Begin> --- BnR Control
    function BNRControl(config) {
        let that = this;
        RED.nodes.createNode(this, config);

        let endpoint = RED.nodes.getNode(config.endpoint);

        if (!endpoint) {
            this.error(RED._("bnr.error.missingconfig"));
            return;
        }

        function onEndpointStatus(status) {
            that.status(generateStatus(status));
        }

        function onMessage(msg, send, done) {
            let func = config.function || msg.function;
            switch (func) {
                case 'cycletime':
                    endpoint.emit('__UPDATE_CYCLE__', {
                        msg: msg,
                        send: send,
                        done: done
                    });
                    break;
                case 'trigger':
                    endpoint.emit('__DO_CYCLE__');
                    send(msg);
                    done();
                    break;

                default:
                    this.error(RED._("bnr.error.invalidcontrolfunction", { function: config.function }), msg);
            }
        }

        function onUpdateCycle(res) {
            let err = res.err;
            if (!err) {
                res.done(err);
            } else {
                res.send(res.msg);
                res.done();
            }
        }

        endpoint.on('__STATUS__', onEndpointStatus);
        endpoint.on('__UPDATE_CYCLE_RES__', onUpdateCycle);

        endpoint.emit('__GET_STATUS__');

        nrInputShim(this, onMessage);

        this.on('close', function (done) {
            endpoint.removeListener('__STATUS__', onEndpointStatus);
            endpoint.removeListener('__UPDATE_CYCLE_RES__', onUpdateCycle);
            done();
        });

    }
    RED.nodes.registerType("bnr control", BNRControl);
    // <End> --- BnR Control
};
