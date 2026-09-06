// Opt-in preload for local regressions. Blocks real network transports before
// imports execute; individual tests may still inject their own fake clients.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

function denied() { throw new Error('Network access forbidden in offline Sora regression'); }
globalThis.fetch = async () => denied();
globalThis.WebSocket = class { constructor() { denied(); } };
http.request = denied; http.get = denied;
https.request = denied; https.get = denied;
net.connect = denied; net.createConnection = denied;
net.Socket.prototype.connect = denied;
tls.connect = denied;
syncBuiltinESMExports();
