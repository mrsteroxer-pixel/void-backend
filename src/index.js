require('dotenv').config();
const http         = require('http');
const path         = require('path');
const express      = require('express');
const { Server }   = require('socket.io');
const helmet       = require('helmet');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');

const authRoutes         = require('./routes/auth.routes');
const inviteRoutes       = require('./routes/invite.routes');
const messageRoutes      = require('./routes/message.routes');
const channelRoutes      = require('./routes/channel.routes');
const dmRoutes           = require('./routes/dm.routes');
const voiceRoutes        = require('./routes/voice.routes');
const uploadRoutes       = require('./routes/upload.routes');
const monetizationRoutes = require('./routes/monetization.routes');
const aiRoutes           = require('./routes/ai.routes');
const adminRoutes        = require('./routes/admin.routes');

const { registerSocketHandlers } = require('./socket');
require('./config/db');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;

const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true },
  pingTimeout: 60000, pingInterval: 25000,
});

registerSocketHandlers(io);
app.set('io', io);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use('/uploads', express.static(path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads')));

app.use('/api/auth',         authRoutes);
app.use('/api/invites',      inviteRoutes);
app.use('/api/messages',     messageRoutes);
app.use('/api/channels',     channelRoutes);
app.use('/api/dms',          dmRoutes);
app.use('/api/voice',        voiceRoutes);
app.use('/api/upload',       uploadRoutes);
app.use('/api/monetization', monetizationRoutes);
app.use('/api/ai',           aiRoutes);
app.use('/api/admin',        adminRoutes);

app.get('/health', (req, res) => res.json({
  status: 'ok', platform: 'VOID',
  timestamp: new Date().toISOString(),
  sockets: io.engine.clientsCount,
}));

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal server error' }); });

server.listen(PORT, () => {
  console.log(`\n  ██╗   ██╗ ██████╗ ██╗██████╗`);
  console.log(`  ╚██╗ ██╔╝██╔═══██╗██║██╔══██╗`);
  console.log(`   ╚████╔╝ ██║   ██║██║██║  ██║`);
  console.log(`    ╚██╔╝  ██║   ██║██║██║  ██║`);
  console.log(`     ██║   ╚██████╔╝██║██████╔╝`);
  console.log(`     ╚═╝    ╚═════╝ ╚═╝╚═════╝\n`);
  console.log(`  Backend      → http://localhost:${PORT}`);
  console.log(`  WebSockets   → ws://localhost:${PORT}`);
  console.log(`  DMs          → E2E encrypted ✓`);
  console.log(`  Voice        → WebRTC signaling ✓`);
  console.log(`  Uploads      → 100MB free ✓`);
  console.log(`  Monetization → Tiers & payouts ✓`);
  console.log(`  AI           → void.ai active ✓`);
  console.log(`  Admin        → Moderation tools ✓`);
  console.log(`  Env          → ${process.env.NODE_ENV || 'development'}\n`);
});
