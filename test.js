var test = require('tape')
var flock = require('./')

test('flock destroys immediately', function(t) {
    var s = flock({ dht: false, utp: false })
    s.destroy(function() {
        t.ok(true, 'destroyed ok')
        t.end()
    })
})

test('flock destroys immediately (utp)', function(t) {
    var s = flock({ dht: false, tcp: false })
    s.destroy(function() {
        t.ok(true, 'destroyed ok')
        t.end()
    })
})

test('flock leave ok', function(t) {
    var s = flock({ dht: false, utp: false })
    s.join('test')
    s.leave('test')
    s.destroy()
    t.pass('leave ok')
    t.end()
})

test('two flocks connect locally', function(t) {
    var pending = 0
    var flocks = []

    create()
    create()

    function create() {
        var s = flock({ dht: false, utp: false })
        flocks.push(s)
        pending++
        s.join('test')

        s.on('connection', function(connection, type) {
            t.ok(connection, 'got connection')
            if (--pending === 0) {
                flocks.forEach(function(s) {
                    s.destroy()
                })
                t.end()
            }
        })

        return s
    }
})

test('two flocks connect and exchange data (tcp)', function(t) {
    var a = flock({ dht: false, utp: false })
    var b = flock({ dht: false, utp: false })

    a.on('connection', function(connection, info) {
        t.ok(info.host && typeof info.host === 'string', 'got info.host')
        t.ok(info.port && typeof info.port === 'number', 'got info.port')
        connection.write('hello')
        connection.on('data', function(data) {
            a.destroy()
            b.destroy()
            t.same(data, Buffer.from('hello'))
            t.end()
        })
    })

    b.on('connection', function(connection, info) {
        t.ok(info.host && typeof info.host === 'string', 'got info.host')
        t.ok(info.port && typeof info.port === 'number', 'got info.port')
        connection.pipe(connection)
    })

    a.join('test')
    b.join('test')
})

test('two flocks connect and exchange data (utp)', function(t) {
    var a = flock({ dht: false, tcp: false })
    var b = flock({ dht: false, tcp: false })

    a.on('connection', function(connection, info) {
        t.ok(info.host && typeof info.host === 'string', 'got info.host')
        t.ok(info.port && typeof info.port === 'number', 'got info.port')
        connection.write('hello')
        connection.on('data', function(data) {
            t.same(a._tcp, null, 'no tcp handler')
            t.same(b._tcp, null, 'no tcp handler')
            a.destroy(function() {
                t.pass('a destroy')
                b.destroy(function() {
                    t.pass('b destroy')
                    t.end()
                })
            })
            t.same(data, Buffer.from('hello'))
        })
    })

    b.on('connection', function(connection, info) {
        t.ok(info.host && typeof info.host === 'string', 'got info.host')
        t.ok(info.port && typeof info.port === 'number', 'got info.port')
        connection.pipe(connection)
    })

    a.join('test')
    b.join('test')
})

test('two flocks connect and callback', function(t) {
    var a = flock({ dht: false, utp: false })
    var b = flock({ dht: false, utp: false })
    var pending = 2

    a.join('test', function() {
        t.pass('connected')
        if (!--pending) done()
    })
    b.join('test', function() {
        t.pass('connected')
        if (!--pending) done()
    })

    function done() {
        a.destroy()
        b.destroy()
        t.end()
    }
})

test('connect many and send data', function(t) {
    var runs = 10
    var outer = 0
    var flocks = []

    for (var i = 0; i < runs; i++) create(i)

    function create(i) {
        var s = flock({ dht: false, utp: false })
        flocks.push(s)

        var seen = {}
        var cnt = 0

        s.on('connection', function(connection) {
            connection.write('' + i)
            connection.on('data', function(data) {
                if (seen[data]) return
                seen[data] = true
                t.pass('flock #' + i + ' received ' + data)
                if (++cnt < runs - 1) return
                if (++outer < runs) return
                flocks.forEach(function(other) {
                    other.destroy()
                })
                t.end()
            })
        })

        s.join('test')
    }
})

test('socket should get destroyed on a bad peer', function(t) {
    var s = flock({ dht: false, utp: false })

    s.addPeer('test', 10003) // should not connect

    process.nextTick(function() {
        t.equal(s.totalConnections, 1, '1 connection')
    })

    s.on('connection', function(connection, type) {
        t.false(connection, 'should never get here')
        s.destroy()
        t.end()
    })

    setTimeout(function() {
        t.equal(s.totalConnections, 0, '0 connections')
        s.destroy()
        t.end()
    }, 250)
})

test('flock should not connect to self', function(t) {
    var s = flock({ dht: false, utp: false })

    s.on('connection', function(connection, type) {
        t.false(connection, 'should never get here')
        s.destroy()
        t.end()
    })

    setTimeout(function() {
        t.equal(s.totalConnections, 0, '0 connections')
        s.destroy()
        t.end()
    }, 250)

    s.join('test')
})

test('flock ignore whitelist', function(t) {
    var s = flock({ dht: false, utp: false, whitelist: ['9.9.9.9'] })
    var emitted = false

    s.on('peer', function() {
        emitted = true
    })

    s.addPeer('127.0.0.1', 9999) // should not connect

    setTimeout(function() {
        t.equal(emitted, false)
        s.destroy()
        t.end()
    }, 250)
})