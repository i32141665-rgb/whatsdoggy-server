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
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // Поддержка больших аудиофайлов

app.use(express.static(path.join(__dirname, 'public')));

let sock = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        syncFullHistory: true, // Включаем полную синхронизацию истории чатов
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const qrImageUrl = await qrcode.toDataURL(qr);
                io.emit('qr', { qr: qrImageUrl });
            } catch (err) {
                console.error('Ошибка QR:', err);
            }
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp успешно подключен!');
            io.emit('ready');
        } else if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(connectToWhatsApp, 3000);
            }
        }
    });

    // Функция для получения аватарки
    async function getProfilePic(jid) {
        try {
            return await sock.profilePictureUrl(jid, 'image');
        } catch {
            return null; // Если у пользователя нет аватарки или скрыта настройками приватности
        }
    }

    // Подгрузка истории чатов при первичном входе через QR
    sock.ev.on('messaging-history.set', async ({ chats }) => {
        console.log(`💬 Синхронизировано чатов: ${chats.length}`);
        const formattedChats = [];

        for (const c of chats) {
            if (!c.id || c.id.includes('@g.us') || c.id.includes('@broadcast')) continue;
            const avatar = await getProfilePic(c.id);
            formattedChats.push({
                id: c.id.split('@')[0],
                jid: c.id,
                name: c.name || c.id.split('@')[0],
                avatar: avatar
            });
        }
        io.emit('chat_list', formattedChats);
    });

    // Обработка входящих сообщений
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const fromJid = msg.key.remoteJid;
            if (!fromJid || fromJid.includes('@g.us') || fromJid.includes('@broadcast')) continue;

            const cleanPhone = fromJid.split('@')[0].split(':')[0].replace(/\D/g, '');
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const avatar = await getProfilePic(fromJid);

            io.emit('message', {
                from: cleanPhone,
                text: text,
                avatar: avatar,
                type: 'text'
            });
        }
    });
}

// Отправка сообщений
io.on('connection', (socket) => {
    socket.on('send_message', async (data) => {
        try {
            if (!sock) return;

            let cleanNumber = String(data.to).replace(/\D/g, '');
            if (cleanNumber.startsWith('8') && cleanNumber.length === 11) {
                cleanNumber = '7' + cleanNumber.slice(1);
            }

            // Поиск реального JID контакта в WhatsApp
            const [result] = await sock.onWhatsApp(`+${cleanNumber}`);
            if (!result || !result.exists) {
                socket.emit('error_msg', { message: 'Этот номер не зарегистрирован в WhatsApp!' });
                return;
            }

            const recipientJid = result.jid;

            // 1. Отправка обычного текста
            if (data.type === 'text') {
                await sock.sendMessage(recipientJid, { text: data.text });
            } 
            // 2. Отправка голосового сообщения (PTT)
            else if (data.type === 'audio') {
                const base64Data = data.text.split(',')[1];
                const audioBuffer = Buffer.from(base64Data, 'base64');

                await sock.sendMessage(recipientJid, {
                    audio: audioBuffer,
                    mimetype: 'audio/mp4', // Совместимый формат для WhatsApp
                    ptt: true // Флаг голосового сообщения
                });
            }
            // 3. Отправка картинки
            else if (data.type === 'image') {
                const base64Data = data.text.split(',')[1];
                const imageBuffer = Buffer.from(base64Data, 'base64');

                await sock.sendMessage(recipientJid, {
                    image: imageBuffer
                });
            }

            console.log(`✅ Сообщение типа [${data.type}] отправлено на ${recipientJid}`);
        } catch (error) {
            console.error('❌ Ошибка отправки:', error);
        }
    });
});

connectToWhatsApp();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));
