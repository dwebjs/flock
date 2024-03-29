var revelation = require(`@dwebjs/channel`)
var pump = require('pump')
var events = require('events')
var util = require('util')
var net = require('net')
var toBuffer = require('to-buffer')
var crypto = require('crypto')
var lpmessage = require('length-prefixed-message')
var connections = require('connections')
var debug = require('debug')('@dwebjs/channel')

try {
    var utp = require('utp-native')
} catch (err) {
    // do nothing
}

var PEER_SEEN = 1
var PEER_BANNED = 2

var HANDSHAKE_TIMEOUT = 5000
var CONNECTION_TIMEOUT = 3000
var RECONNECT_WAIT = [1000, 1000, 5000, 15000]
    // var DEFAULT_SIZE = 100 // TODO enable max connections

module.exports = Flock

function Flock(opts) {
    if (!(this instanceof Flock)) return new Flock(opts)
    if (!opts) opts = {}
    events.EventEmitter.call(this)

    var self = this

    this.maxConnections = opts.maxConnections || 0
    this.totalConnections = 0

    this.connections = []
    this.id = opts.id || crypto.randomBytes(32)
    this.destroyed = false

    this._stream = opts.stream
    this._options = opts || {}
    this._whitelist = opts.whitelist || []
    this._revelation = null
    this._tcp = opts.tcp === false ? null : net.createServer().on('connection', onconnection)
    this._utp = opts.utp === false || !utp ? null : utp().on('connection', onconnection)
    this._tcpConnections = this._tcp && connections(this._tcp)
    this._adding = null
    this._listening = false

    this._peersIds = {}
    this._peersSeen = {}
    this._peersQueued = []

    if (this._options.revelation !== false) {
        this.on('listening', this._onrevelate)
    }

    function onconnection(connection) {
        var type = this === self._tcp ? 'tcp' : 'utp'
        debug('inbound connection type=%s ip=%s:%d', type, connection.remoteAddress, connection.remotePort)
        connection.on('error', onerror)
        self.totalConnections++
            self._onconnection(connection, type, null)
    }
}

util.inherits(Flock, events.EventEmitter)

Flock.prototype.close =
    Flock.prototype.destroy = function(onclose) {
        if (this.destroyed) return process.nextTick(onclose || noop)
        if (onclose) this.once('close', onclose)
        if (this._listening && this._adding) return this.once('listening', this.destroy)

        this.destroyed = true
        if (this._revelation) this._revelation.destroy()

        var self = this
        var missing = 0

        if (this._utp) {
            missing++
            for (var i = 0; i < this._utp.connections.length; i++) {
                this._utp.connections[i].destroy()
            }
        }

        if (this._tcp) {
            missing++
            this._tcpConnections.destroy()
        }

        if (this._listening) {
            if (this._tcp) this._tcp.close(onserverclose)
            if (this._utp) this._utp.close(onserverclose)
        } else {
            this.emit('close')
        }

        function onserverclose() {
            if (!--missing) self.emit('close')
        }
    }

Flock.prototype.__defineGetter__('queued', function() {
    return this._peersQueued.length
})

Flock.prototype.__defineGetter__('connecting', function() {
    return this.totalConnections - this.connections.length
})

Flock.prototype.__defineGetter__('connected', function() {
    return this.connections.length
})

Flock.prototype.join = function(name, opts, cb) {
    if (typeof opts === 'function') return this.join(name, {}, opts)
    name = toBuffer(name)
    if (!opts) opts = {}
    if (typeof opts.announce === 'undefined') opts.announce = true

    if (!this._listening && !this._adding) this._listenNext()

    if (this._adding) {
        this._adding.push({ name: name, opts: opts, cb: cb })
    } else {
        var port
        if (opts.announce) port = this.address().port
        this._revelation.join(name, port, { impliedPort: opts.announce && !!this._utp }, cb)
    }
}

Flock.prototype.leave = function(name) {
    name = toBuffer(name)

    if (this._adding) {
        for (var i = 0; i < this._adding.length; i++) {
            if (name.equals(this._adding[i].name)) {
                this._adding.splice(i, 1)
                return
            }
        }
    } else {
        this._revelation.leave(name, this.address() ? this.address().port : 0)
    }
}

Flock.prototype.addPeer = function(name, peer) {
    peer = peerify(peer, toBuffer(name))
    if (this._peersSeen[peer.id]) return
    if (this._whitelist.length && this._whitelist.indexOf(peer.host) === -1) return
    this._peersSeen[peer.id] = PEER_SEEN
    this._peersQueued.push(peer)
    this.emit('peer', peer)
    this._kick()
}

Flock.prototype.removePeer = function(name, peer) {
    peer = peerify(peer, toBuffer(name))
    this._peersSeen[peer.id] = PEER_BANNED
    this.emit('peer-banned', peer, { reason: 'application' })
}

Flock.prototype._dropPeer = function(peer) {
    delete this._peersSeen[peer.id]
    this.emit('drop', peer)
}

Flock.prototype.address = function() {
    return this._tcp ? this._tcp.address() : this._utp.address()
}

Flock.prototype._onrevelate = function() {
    var self = this
    var joins = this._adding

    if (this._options.dns !== false) {
        if (!this._options.dns || this._options.dns === true) this._options.dns = {}
        this._options.dns.socket = this._utp
    }

    if (this._options.dht !== false) {
        if (!this._options.dht || this._options.dht === true) this._options.dht = {}
        this._options.dht.socket = this._utp
    }
    this._revelation = revelation(this._options)
    this._revelation.on('peer', onpeer)
    this._revelation.on('whoami', onwhoami)
    this._adding = null

    if (!joins) return
    for (var i = 0; i < joins.length; i++) this.join(joins[i].name, joins[i].opts, joins[i].cb)

    function onwhoami(me) {
        self._peersSeen[me.host + ':' + me.port] = PEER_BANNED
    }

    function onpeer(channel, peer) {
        var id = peer.host + ':' + peer.port
        var longId = id + '@' + (channel ? channel.toString('hex') : '')
        if (self._whitelist.length && self._whitelist.indexOf(peer.host) === -1) {
            self.emit('peer-rejected', peer, { reason: 'whitelist' })
            return
        }
        var peerSeen = self._peersSeen[id] || self._peersSeen[longId]
        if (peerSeen) {
            self.emit('peer-rejected', peer, { reason: (peerSeen === PEER_BANNED) ? 'banned' : 'duplicate' })
            return
        }
        self._peersSeen[longId] = PEER_SEEN
        self._peersQueued.push(peerify(peer, channel))
        self.emit('peer', peer)
        self._kick()
    }
}

Flock.prototype._kick = function() {
    if (this.maxConnections && this.totalConnections >= this.maxConnections) return
    if (this.destroyed) return

    var self = this
    var connected = false
    var didTimeOut = false
    var next = this._peersQueued.shift()
    while (next && this._peersSeen[next.id] === PEER_BANNED) {
        next = this._peersQueued.shift()
    }

    if (!next) return

    this.totalConnections++
        this.emit('connecting', next)
    debug('connecting %s retries=%d', next.id, next.retries)

    var tcpSocket = null
    var utpSocket = null
    var tcpClosed = true
    var utpClosed = true

    if (this._tcp) {
        tcpClosed = false
        tcpSocket = net.connect(next.port, next.host)
        tcpSocket.on('connect', onconnect)
        tcpSocket.on('error', onerror)
        tcpSocket.on('close', onclose)
        this._tcpConnections.add(tcpSocket)
    }

    if (this._utp) {
        utpClosed = false
        utpSocket = this._utp.connect(next.port, next.host)
        utpSocket.on('connect', ondeferredconnect)
        utpSocket.on('error', onerror)
        utpSocket.on('close', onclose)
    }

    var timeout = setTimeoutUnref(ontimeout, CONNECTION_TIMEOUT)

    function ondeferredconnect() {
        if (!self._tcp || tcpClosed) return onconnect.call(utpSocket)
        setTimeout(function() {
            if (!utpClosed && !connected) onconnect.call(utpSocket)
        }, 500)
    }

    function ontimeout() {
        debug('timeout %s', next.id)
        didTimeOut = true
        if (utpSocket) utpSocket.destroy()
        if (tcpSocket) tcpSocket.destroy()
    }

    function cleanup() {
        clearTimeout(timeout)
        if (utpSocket) utpSocket.removeListener('close', onclose)
        if (tcpSocket) tcpSocket.removeListener('close', onclose)
    }

    function onclose() {
        if (this === utpSocket) utpClosed = true
        if (this === tcpSocket) tcpClosed = true
        if (tcpClosed && utpClosed) {
            debug('onclose utp+tcp %s will-requeue=%d', next.id, !connected)
            cleanup()
            if (!connected) {
                self.totalConnections--
                    self.emit('connect-failed', next, { timedout: didTimeOut })
                self._requeue(next)
            }
        }
    }

    function onconnect() {
        connected = true
        cleanup()

        var type = this === utpSocket ? 'utp' : 'tcp'
        debug('onconnect %s type=%s', next.id, type)
        if (type === 'utp' && tcpSocket) tcpSocket.destroy()
        if (type === 'tcp' && utpSocket) utpSocket.destroy()

        self._onconnection(this, type, next)
    }
}

Flock.prototype._requeue = function(peer) {
    if (this.destroyed) return

    var self = this
    var wait = peer.retries >= RECONNECT_WAIT.length ? 0 : RECONNECT_WAIT[peer.retries++]
    if (wait) setTimeoutUnref(requeue, wait)
    else this._dropPeer(peer)

    function requeue() {
        self._peersQueued.push(peer)
        self._kick()
    }
}

var connectionDebugIdCounter = 0
Flock.prototype._onconnection = function(connection, type, peer) {
    var self = this
    var idHex = this.id.toString('hex')
    var remoteIdHex

    // internal variables used for debugging
    connection._debugId = ++connectionDebugIdCounter
    connection._debugStartTime = Date.now()

    var info = {
        type: type,
        initiator: !!peer,
        id: null,
        host: peer ? peer.host : connection.remoteAddress,
        port: peer ? peer.port : connection.remotePort,
        channel: peer ? peer.channel : null
    }
    this.emit('handshaking', connection, info)

    connection.on('close', onclose)

    if (this._stream) {
        var wire = connection
        connection = this._stream(info)
        connection._debugId = wire._debugId
        connection._debugStartTime = wire._debugStartTime
        if (connection.id) idHex = connection.id.toString('hex')
        connection.on('handshake', onhandshake)
        if (this._options.connect) this._options.connect(connection, wire)
        else pump(wire, connection, wire)
    } else {
        handshake(connection, this.id, onhandshake)
    }

    var wrap = {
        info: info,
        connection: connection
    }

    var timeout = setTimeoutUnref(ontimeout, HANDSHAKE_TIMEOUT)
    if (this.destroyed) connection.destroy()

    function ontimeout() {
        self.emit('handshake-timeout', connection, info)
        connection.destroy()
    }

    function onclose() {
        clearTimeout(timeout)
        self.totalConnections--
            self.emit('connection-closed', connection, info)

        var i = self.connections.indexOf(connection)
        if (i > -1) {
            var last = self.connections.pop()
            if (last !== connection) self.connections[i] = last
        }

        if (remoteIdHex && self._peersIds[remoteIdHex] && self._peersIds[remoteIdHex].connection === connection) {
            delete self._peersIds[remoteIdHex]
            if (peer) self._requeue(peer)
        }
    }

    function onhandshake(remoteId) {
        if (!remoteId) remoteId = connection.remoteId
        clearTimeout(timeout)
        remoteIdHex = remoteId.toString('hex')

        if (Buffer.isBuffer(connection.revelationKey) || Buffer.isBuffer(connection.channel)) {
            var suffix = '@' + (connection.revelationKey || connection.channel).toString('hex')
            remoteIdHex += suffix
            idHex += suffix
        }

        if (peer) peer.retries = 0

        if (idHex === remoteIdHex) {
            if (peer) {
                self._peersSeen[peer.id] = PEER_BANNED
                self.emit('peer-banned', { peer: peer, reason: 'detected-self' })
            }
            connection.destroy()
            return
        }

        var oldWrap = self._peersIds[remoteIdHex]
        var old = oldWrap && oldWrap.connection
        var oldType = oldWrap && oldWrap.info.type

        if (old) {
            debug('duplicate connections detected in handshake, dropping one')
            if (!(oldType === 'utp' && type === 'tcp')) {
                if ((peer && remoteIdHex < idHex) || (!peer && remoteIdHex > idHex) || (type === 'utp' && oldType === 'tcp')) {
                    self.emit('redundant-connection', connection, info)
                    connection.destroy()
                    return
                }
            }
            self.emit('redundant-connection', old, info)
            delete self._peersIds[remoteIdHex] // delete to not trigger re-queue
            old.destroy()
            old = null // help gc
        }

        self._peersIds[remoteIdHex] = wrap
        self.connections.push(connection)
        info.id = remoteId
        self.emit('connection', connection, info)
    }
}

Flock.prototype._listenNext = function() {
    var self = this
    if (!this._adding) this._adding = []
    process.nextTick(function() {
        if (!self._listening) self.listen()
    })
}

Flock.prototype.listen = function(port, onlistening) {
    if (this.destroyed) return
    if (this._tcp && this._utp) return this._listenBoth(port, onlistening)
    if (!port) port = 0
    if (onlistening) this.once('listening', onlistening)

    var self = this
    var server = this._tcp || this._utp

    if (!this._listening) {
        this._listening = true
        server.on('error', onerror)
        server.on('listening', onlisten)
    }

    if (!this._adding) this._adding = []
    server.listen(port)

    function onerror(err) {
        self.emit('error', err)
    }

    function onlisten() {
        self.emit('listening')
    }
}

Flock.prototype._listenBoth = function(port, onlistening) {
    if (typeof port === 'function') return this.listen(0, port)
    if (!port) port = 0
    if (onlistening) this.once('listening', onlistening)

    var self = this

    if (!this._adding) this._adding = []
    this._listening = true

    this._utp.on('error', onerror)
    this._utp.on('listening', onutplisten)
    this._tcp.on('listening', ontcplisten)
    this._tcp.on('error', onerror)
    this._tcp.listen(port)

    function cleanup() {
        self._utp.removeListener('error', onerror)
        self._tcp.removeListener('error', onerror)
        self._utp.removeListener('listening', onutplisten)
        self._tcp.removeListener('listening', ontcplisten)
    }

    function onerror(err) {
        cleanup()
        self._tcp.close(function() {
            if (!port) return self.listen() // retry
            self.emit('error', err)
        })
    }

    function onutplisten() {
        cleanup()
        self._utp.on('error', forward)
        self._tcp.on('error', forward)
        self.emit('listening')
    }

    function ontcplisten() {
        self._utp.listen(this.address().port)
    }

    function forward(err) {
        self.emit('error', err)
    }
}

function handshake(socket, id, cb) {
    lpmessage.write(socket, id)
    lpmessage.read(socket, cb)
}

function onerror() {
    this.destroy()
}

function peerify(peer, channel) {
    if (typeof peer === 'number') peer = { port: peer }
    if (!peer.host) peer.host = '127.0.0.1'
    peer.id = peer.host + ':' + peer.port + '@' + (channel ? channel.toString('hex') : '')
    peer.retries = 0
    peer.channel = channel
    return peer
}

function setTimeoutUnref(fn, time) {
    var timeout = setTimeout(fn, time)
    if (timeout.unref) timeout.unref()
    return timeout
}

function noop() {}