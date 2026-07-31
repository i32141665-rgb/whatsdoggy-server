import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname)); // отдаем файлы прямо из папки проекта

let sock;
let isConnected = false;
let currentQR = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) io.emit('qr_code', url);
            });
        }

        if (connection === 'open') {
            console.log('>>> WhatsApp connected successfully! <<<');
            isConnected = true;
            currentQR = null;
            io.emit('connection_status', { connected: true });
        } else if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            io.emit('connection_status', { connected: false });
            
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (text) {
            io.emit('new_message', {
                from: sender,
                text: text,
                fromMe: msg.key.fromMe
            });
        }
    });
}

io.on('connection', (socket) => {
    socket.on('check_status', () => {
        socket.emit('connection_status', { connected: isConnected });
        
        if (!isConnected && currentQR) {
            QRCode.toDataURL(currentQR, (err, url) => {
                if (!err) socket.emit('qr_code', url);
            });
        }
    });
});

app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;

    if (!isConnected) {
        return res.status(400).json({ status: 'error', message: 'WhatsApp не подключен' });
    }

    try {
        const formattedNumber = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        await sock.sendMessage(formattedNumber, { text: message });
        res.json({ status: 'success' });
    } catch (err) {
        console.error('Send error:', err);
        res.status(500).json({ status: 'error', message: 'Не удалось отправить сообщение' });
    }
});

// Выход из аккаунта
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        fs.rmSync(path.join(__dirname, 'auth_info_baileys'), { recursive: true, force: true });
        res.json({ status: 'success' });
    } catch (err) {
        res.status(500).json({ status: 'error' });
    }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server WhatsDoggy running on http://localhost:${PORT}`);
    connectToWhatsApp();
});