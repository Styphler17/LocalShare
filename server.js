const express = require('express');
const http = require('http');
const cors = require('cors');
const favicon = require('serve-favicon');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const qrcode = require('qrcode');
const dgram = require('dgram');

const SETTINGS_FILE = path.join(__dirname, 'localshare-settings.json');
let settings = {
    uploadDir: path.join(os.homedir(), 'Downloads', 'LocalShare'),
    startHidden: false,
    deviceName: "Device " + Math.floor(Math.random() * 1000),
    trustedDevices: [],
    autoAcceptEnabled: false,
    historyClearedAt: ""
};

// Load settings if they exist
if (fs.existsSync(SETTINGS_FILE)) {
    try {
        const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
        settings = { ...settings, ...JSON.parse(data) };
    } catch (e) {
        console.error("Error reading settings file:", e);
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) {
        console.error("Error saving settings file:", e);
    }
}

let uploadDir = settings.uploadDir;
const DISCOVERY_PORT = 53535;
const DISCOVERY_INTERVAL = 5000;
const DISCOVERY_TYPE = 'LOCALSHARE_DISCOVERY';

function setUploadDir(newDir) {
  uploadDir = newDir;
  settings.uploadDir = newDir;
  saveSettings();
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
}

function getUploadDir() {
  return uploadDir;
}

function getSettings() {
    return settings;
}

function updateSetting(key, value) {
    settings[key] = value;
    saveSettings();
}

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  let fallbackIp = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const n = name.toLowerCase();
        if (n.includes('vmware') || n.includes('virtual') || n.includes('vbox') || n.includes('wsl') || n.includes('hyper')) {
            if (fallbackIp === 'localhost') fallbackIp = iface.address;
            continue;
        }
        return iface.address;
      }
    }
  }
  return fallbackIp !== 'localhost' ? fallbackIp : 'localhost';
}

function startServer() {
  const app = express();
  app.use(cors());
  app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: "*" } });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      cb(null, `${timestamp}-${safeName}`);
    }
  });

  const upload = multer({ storage: storage });

  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());
  
  app.use('/uploads', (req, res, next) => {
    express.static(uploadDir)(req, res, next);
  });

  const PORT = process.env.PORT || 3000;
  const IP_ADDRESS = getLocalIp();

  // In-memory file metadata and connected devices
  let filesMetadata = [];

  app.post('/api/clear-history', (req, res) => {
      console.log('API Call: Clear History received');
      const now = new Date();
      updateSetting('historyClearedAt', now.toISOString());
      filesMetadata = [];
      res.json({ success: true, message: "History cleared. Files remain on disk." });
  });

  app.get('/api/ping', (req, res) => {
      res.json({ status: 'ok', time: new Date().toISOString() });
  });


  const connectedDevices = {}; // { socketId: { id, name } }
  const discoveredHubs = {};   // { ip: { name, port, lastSeen } }
  const pendingRemoteHandshakes = {}; // { id: { res, timer } }

  function startDiscovery(deviceName, port) {
      // ... (existing code remains unchanged above) ...
    const serverSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    
    serverSocket.on('message', (msg, rinfo) => {
        try {
            const data = JSON.parse(msg.toString());
            if (data.type === DISCOVERY_TYPE && rinfo.address !== IP_ADDRESS) {
                const now = Date.now();
                if (!discoveredHubs[rinfo.address] || discoveredHubs[rinfo.address].name !== data.name) {
                   console.log(`Discovered new LocalShare Hub: ${data.name} at ${rinfo.address}`);
                }
                discoveredHubs[rinfo.address] = {
                    id: `remote_${rinfo.address}`,
                    name: data.name,
                    port: data.port,
                    ip: rinfo.address,
                    lastSeen: now,
                    isRemoteHub: true
                };
                
                // Cleanup old hubs
                for (const ip in discoveredHubs) {
                    if (now - discoveredHubs[ip].lastSeen > DISCOVERY_INTERVAL * 3) {
                        delete discoveredHubs[ip];
                    }
                }
                
                io.emit('device_list_update', getCombinedDeviceList());
            }
        } catch (e) {}
    });

    serverSocket.on('error', (err) => {
        console.error('Discovery socket error:', err);
    });

    serverSocket.bind(DISCOVERY_PORT, () => {
        serverSocket.setBroadcast(true);
        console.log(`Discovery listening on port ${DISCOVERY_PORT}`);
        
        setInterval(() => {
            const announcement = JSON.stringify({
                type: DISCOVERY_TYPE,
                name: deviceName,
                port: port
            });
            serverSocket.send(announcement, 0, announcement.length, DISCOVERY_PORT, '255.255.255.255');
        }, DISCOVERY_INTERVAL);
    });
  }

  function getCombinedDeviceList() {
    const local = Object.values(connectedDevices);
    const remotes = Object.values(discoveredHubs);
    return [...local, ...remotes];
  }

  function syncFiles() {
    if (!fs.existsSync(uploadDir)) return;
    const files = fs.readdirSync(uploadDir);
    
    // remove metadata for files that no longer exist
    filesMetadata = filesMetadata.filter(m => files.includes(m.name));
    
    // add missing files (from desktop side or older uploads)
    const existingNames = filesMetadata.map(f => f.name);
    files.forEach(filename => {
      if (!existingNames.includes(filename)) {
        const filePath = path.join(uploadDir, filename);
        let stats;
        try { stats = fs.statSync(filePath); } catch(e) { return; }
        
        const dashIdx = filename.indexOf('-');
        const originalName = dashIdx > -1 ? filename.substring(dashIdx + 1).replace(/_/g, ' ') : filename;
        const ext = path.extname(filename).toLowerCase();
        let type = 'other';
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) type = 'image';
        else if (['.mp4', '.webm', '.ogg', '.mov', '.avi'].includes(ext)) type = 'video';
        else if (['.mp3', '.wav', '.flac', '.m4a', '.aac'].includes(ext)) type = 'audio';
        
        filesMetadata.push({
          name: filename,
          originalName,
          size: stats.size,
          date: stats.mtime,
          type,
          isPublic: true,
          sender: null,
          recipientId: null
        });
      }
    });
  }



  app.get('/api/files', (req, res) => {
    const socketId = req.query.socketId;
    const clearedAt = getSettings().historyClearedAt ? new Date(getSettings().historyClearedAt) : new Date(0);

    // Filter files:
    // 1. Must be newer than the last "Clear History" action
    // 2. Public OR sent to this user OR sent by this user
    const userFiles = filesMetadata.filter(f => {
      const fileDate = new Date(f.date);
      if (fileDate <= clearedAt) return false;

      if (f.isPublic) return true;
      if (f.recipientId === socketId) return true;
      if (f.sender && f.sender.id === socketId) return true;
      return false;
    }).sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(userFiles);
  });

  app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const dashIdx = req.file.filename.indexOf('-');
    const originalName = dashIdx > -1 ? req.file.filename.substring(dashIdx + 1).replace(/_/g, ' ') : req.file.filename;
    
    const ext = path.extname(req.file.filename).toLowerCase();
    let type = 'other';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) type = 'image';
    else if (['.mp4', '.webm', '.ogg', '.mov', '.avi'].includes(ext)) type = 'video';
    else if (['.mp3', '.wav', '.flac', '.m4a', '.aac'].includes(ext)) type = 'audio';

    const { recipientId, senderId, senderName, recipientName } = req.body;
    
    if (!recipientId || recipientId === 'everyone') {
        return res.status(400).json({ error: 'Transfer must have a dedicated recipient device on the network.' });
    }

    const fileInfo = {
      name: req.file.filename,
      originalName,
      size: req.file.size,
      date: new Date(),
      type,
      isPublic: false,
      sender: senderId ? { id: senderId, name: senderName } : null,
      recipientId: recipientId,
      recipientName: recipientName
    };

    filesMetadata.push(fileInfo);
    
    io.to(recipientId).emit('new_file', fileInfo);
    if (senderId) io.to(senderId).emit('new_file', fileInfo);

    res.status(200).json({ success: true, file: fileInfo });
  });

  app.post('/api/upload-text', (req, res) => {
    const { senderId, senderName, recipientId, recipientName, textContent, payloadType } = req.body;
    
    if (!recipientId || recipientId === 'everyone') {
        return res.status(400).json({ error: 'Transfer must have a dedicated recipient device.' });
    }

    const fileInfo = {
      name: `payload_${Date.now()}`,
      originalName: payloadType === 'link' ? textContent.substring(0, 45) : (textContent.substring(0, 30) + (textContent.length > 30 ? '...' : '')),
      size: Buffer.byteLength(textContent, 'utf8'),
      date: new Date(),
      type: payloadType || 'text',
      textContent: textContent,
      isPublic: false,
      sender: senderId ? { id: senderId, name: senderName } : null,
      recipientId: recipientId,
      recipientName: recipientName
    };

    filesMetadata.push(fileInfo);
    
    io.to(recipientId).emit('new_file', fileInfo);
    if (senderId) io.to(senderId).emit('new_file', fileInfo);

    res.status(200).json({ success: true, file: fileInfo });
  });

  app.get('/api/server-info', async (req, res) => {
    const url = `http://${IP_ADDRESS}:${PORT}`;
    try {
      const qrCodeDataUrl = await qrcode.toDataURL(url, { margin: 1, width: 250 });
      res.json({ url, qrCodeDataUrl });
    } catch (err) {
      res.status(500).json({ error: 'Failed' });
    }
  });

  // --- REMOTE HUB-TO-HUB ENDPOINTS ---
  
  app.post('/api/remote/handshake', (req, res) => {
      const { sessionId, senderName, fileCount, totalSize, fileNames, payloadType } = req.body;
      const remoteId = `remote_session_${sessionId}`;
      
      // Broadcast to local UI to show incoming transfer modal
      io.emit('incoming_transfer', {
          senderId: remoteId,
          senderName: senderName,
          fileCount: fileCount,
          totalSize: totalSize,
          fileNames: fileNames,
          payloadType: payloadType || 'files'
      });

      // Keep HTTP request alive until UI responds
      const timer = setTimeout(() => {
          if (pendingRemoteHandshakes[remoteId]) {
              pendingRemoteHandshakes[remoteId].res.status(408).json({ accepted: false, reason: 'timeout' });
              delete pendingRemoteHandshakes[remoteId];
          }
      }, 60000); // 60s timeout

      pendingRemoteHandshakes[remoteId] = { res, timer };
  });

  app.post('/api/remote/progress', (req, res) => {
      // Forward progress updates from remote sender to local UI
      io.emit('transfer_progress', req.body);
      res.json({ success: true });
  });

  app.post('/api/remote/upload', upload.single('file'), (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      
      const ext = path.extname(req.file.filename).toLowerCase();
      let type = 'other';
      if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) type = 'image';
      else if (['.mp4', '.webm', '.ogg', '.mov', '.avi'].includes(ext)) type = 'video';
      else if (['.mp3', '.wav', '.flac', '.m4a', '.aac'].includes(ext)) type = 'audio';

      const fileInfo = {
        name: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        date: new Date(),
        type,
        isPublic: false,
        sender: { id: req.body.senderId, name: req.body.senderName },
        recipientId: 'hub_local', // Special ID for local storage
        recipientName: 'This Hub'
      };

      filesMetadata.push(fileInfo);
      io.emit('new_file', fileInfo); // Notify all local UIs connected to this hub
      res.status(200).json({ success: true, file: fileInfo });
  });

  app.post('/api/remote/upload-text', (req, res) => {
      const { senderId, senderName, textContent, payloadType } = req.body;

      const fileInfo = {
        name: `payload_${Date.now()}`,
        originalName: payloadType === 'link' ? textContent.substring(0, 45) : (textContent.substring(0, 30) + (textContent.length > 30 ? '...' : '')),
        size: Buffer.byteLength(textContent, 'utf8'),
        date: new Date(),
        type: payloadType || 'text',
        textContent: textContent,
        isPublic: false,
        sender: { id: senderId, name: senderName },
        recipientId: 'hub_local',
        recipientName: 'This Hub'
      };

      filesMetadata.push(fileInfo);
      io.emit('new_file', fileInfo);
      res.status(200).json({ success: true, file: fileInfo });
  });

  // -----------------------------------

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    // Set a default name based on IP or random ID initially
    connectedDevices[socket.id] = { id: socket.id, name: 'Anonymous Device' };
    
    socket.on('set_device_name', (name) => {
      console.log(`Setting device name for ${socket.id} to ${name}`);
      if (connectedDevices[socket.id]) {
        connectedDevices[socket.id].name = name;
        io.emit('device_list_update', getCombinedDeviceList());
        
        // Initializing discovery if not already done, or restart with new name
        if (!socket.discoveryStarted) {
            startDiscovery(name, PORT);
            socket.discoveryStarted = true;
        }
      }
    });

    // Send initial list to everyone
    console.log('Broadcasting device list update on connection');
    io.emit('device_list_update', getCombinedDeviceList());

    socket.on('request_device_list', () => {
      console.log(`Device list requested by ${socket.id}`);
      // Force push latest device list straight back to the socket requester
      socket.emit('device_list_update', getCombinedDeviceList());
    });

    // Handshake Relay
    socket.on('request_transfer', (req) => {
      io.to(req.targetId).emit('incoming_transfer', {
          senderId: socket.id,
          senderName: req.senderName,
          fileCount: req.fileCount,
          totalSize: req.totalSize,
          fileNames: req.fileNames,
          payloadType: req.payloadType || 'files'
      });
    });

    socket.on('transfer_response', (res) => {
      if (res.targetId.startsWith('remote_session_')) {
          // Resolve the pending HTTP request for Hub-to-Hub transfer
          if (pendingRemoteHandshakes[res.targetId]) {
              clearTimeout(pendingRemoteHandshakes[res.targetId].timer);
              pendingRemoteHandshakes[res.targetId].res.json({ accepted: res.accepted });
              delete pendingRemoteHandshakes[res.targetId];
          }
      } else {
          // Standard local socket relay
          io.to(res.targetId).emit('transfer_response', {
              accepted: res.accepted,
              responderId: socket.id
          });
      }
    });

    socket.on('transfer_progress', (data) => {
      io.to(data.targetId).emit('transfer_progress', {
          senderId: socket.id,
          fileName: data.fileName,
          percentage: data.percentage,
          currentIndex: data.currentIndex,
          totalCount: data.totalCount
      });
    });

    socket.on('disconnect', () => {
      delete connectedDevices[socket.id];
      io.emit('device_list_update', getCombinedDeviceList());
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} already in use — another instance may be running.`);
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = { startServer, setUploadDir, getUploadDir, getSettings, updateSetting };
