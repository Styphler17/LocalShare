const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell } = require('electron');
const path = require('path');
const { startServer, setUploadDir, getUploadDir, getSettings, updateSetting } = require('./server');

let mainWindow;
let tray = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, 'public', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    autoHideMenuBar: true,
    show: false
  });

  mainWindow.loadURL('http://localhost:3000');

  mainWindow.once('ready-to-show', () => {
      const settings = getSettings();
      if (!settings.startHidden) {
          mainWindow.show();
      }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

function createTray() {
    const iconPath = path.join(__dirname, 'public', 'logo.png');
    tray = new Tray(iconPath);
    tray.setToolTip('LocalShare');
    
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open LocalShare', click: () => mainWindow.show() },
        { type: 'separator' },
        { label: 'Quit', click: () => {
            isQuitting = true;
            app.quit();
        }}
    ]);
    
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    startServer();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC HANDLERS ---
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Destination Folder',
    properties: ['openDirectory', 'createDirectory']
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const newDir = result.filePaths[0];
    setUploadDir(newDir);
    return newDir;
  }
  return null;
});

ipcMain.handle('set-upload-dir', (event, dir) => {
    setUploadDir(dir);
});

ipcMain.handle('get-current-folder', () => {
  return getUploadDir();
});

ipcMain.handle('get-settings', () => {
    return getSettings();
});

ipcMain.handle('open-folder', () => {
    shell.openPath(getUploadDir());
});

ipcMain.handle('update-setting', (event, key, value) => {
    updateSetting(key, value);
    return getSettings();
});