import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let sock = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        // Оптимизация против таймаутов (ошибки 408) и зависаний на Render
        syncFullHistory: false,           // Не качаем старую историю
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('⚡ Новый QR-код сгенерирован!');
            try {
                const qrImageUrl = await qrcode.toDataURL(qr);
                io.emit('qr', { qr: qrImageUrl });
            } catch (err) {
                console.error('Ошибка генерации QR DataURL:', err);
            }
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp успешно подключен!');
            io.emit('ready');
        } else if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Соединение закрыто (код ${statusCode}). Переподключение: ${shouldReconnect}`);
            
            if (sock) {
                sock.ev.removeAllListeners();
            }

            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        }
    });

    // Прием входящих сообщений из WhatsApp
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const fromJid = msg.key.remoteJid;
            if (!fromJid || fromJid.includes('@g.us') || fromJid.includes('@broadcast') || fromJid.includes('@lid')) {
                continue;
            }

            const cleanPhone = fromJid.split('@')[0].split(':')[0].replace(/\D/g, '');
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            io.emit('message', {
                from: cleanPhone,
                text: text,
                type: 'text'
            });
        }
    });
}

// Прием отправки из браузера
io.on('connection', (socket) => {
    console.log('🔌 Браузер подключен к сокету');

    socket.on('send_message', async (data) => {
        try {
            console.log('📩 Получены данные от браузера:', data);

            const rawNumber = data.to || data.phone || data.number;
            const messageText = data.text || data.message;

            if (!rawNumber || !sock) {
                console.error('❌ Ошибка: не указан номер или сокет WA не готов!');
                socket.emit('error_msg', { message: 'WhatsApp еще не подключен' });
                return;
            }

            // 1. Очищаем номер от любых символов
            let cleanNumber = String(rawNumber).replace(/\D/g, '');

            // 2. Исправляем казахстанский/российский формат с 8 на 7
            if (cleanNumber.startsWith('8') && cleanNumber.length === 11) {
                cleanNumber = '7' + cleanNumber.slice(1);
            }

            const searchPhone = '+' + cleanNumber;
            console.log(`🔍 Проверяем номер в WhatsApp: ${searchPhone}`);

            let recipientJid = `${cleanNumber}@s.whatsapp.net`;

            // 3. Запрашиваем точный JID и ключи E2EE
            try {
                const results = await sock.onWhatsApp(searchPhone);
                if (results && results.length > 0 && results[0].exists) {
                    recipientJid = results[0].jid;
                    console.log(`🎯 Найден валидный JID: ${recipientJid}`);
                } else {
                    console.warn(`⚠️ onWhatsApp не подтвердил номер, используем запасной JID: ${recipientJid}`);
                }
            } catch (wErr) {
                console.error('⚠️ Ошибка при запросе onWhatsApp:', wErr?.message);
            }

            console.log(`🚀 Отправка в WhatsApp на JID: ${recipientJid} | Текст: "${messageText}"`);

            // 4. Отправляем сообщение
            const sentMsg = await sock.sendMessage(recipientJid, { text: messageText });
            console.log('✅ Сообщение успешно отправлено!', sentMsg?.key);

        } catch (error) {
            console.error('❌ Ошибка при отправке:', error);
            socket.emit('error_msg', { message: 'Ошибка при отправке сообщения' });
        }
    });
});

connectToWhatsApp();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер WhatsDoggy запущен на порту ${PORT}`));
