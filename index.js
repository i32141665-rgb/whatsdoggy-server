import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Обслуживаем статику (твой index.html)
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname)));

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'qr';
            io.emit('qr', qr);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'disconnected';
            qrCodeData = null;
            io.emit('status', 'disconnected');
            if (shouldReconnect) {
                startWhatsApp();
            }
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            qrCodeData = null;
            io.emit('status', 'connected');
            console.log('WhatsApp успешно подключен!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Получение входящих сообщений
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message) continue;
            io.emit('message', msg);
        }
    });
}

// Связь с клиентской частью через Socket.IO
io.on('connection', (socket) => {
    socket.emit('status', connectionStatus);
    if (qrCodeData) {
        socket.emit('qr', qrCodeData);
    }

    // Отправка текстовых сообщений
    socket.on('send-message', async (data) => {
        try {
            if (!sock) return;
            const jid = data.number.includes('@s.whatsapp.net') ? data.number : data.number + '@s.whatsapp.net';
            await sock.sendMessage(jid, { text: data.text });
        } catch (e) {
            console.error('Ошибка отправки сообщения:', e);
        }
    });

    // Отправка голосовых (важно: ptt: true и mimetype для нормального отображения в WhatsApp)
    socket.on('send-voice', async (data) => {
        try {
            if (!sock) return;
            const jid = data.number.includes('@s.whatsapp.net') ? data.number : data.number + '@s.whatsapp.net';
            
            // Получаем аудио из Base64, которое прислал клиент
            const base64Data = data.audio.replace(/^data:.*;base64,/, "");
            const buffer = Buffer.from(base64Data, 'base64');

            await sock.sendMessage(jid, {
                audio: buffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true // Превращает аудио в полноценное голосовое сообщение с волной
            });
        } catch (e) {
            console.error('Ошибка отправки голосового:', e);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    startWhatsApp();
});
