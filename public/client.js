document.addEventListener('DOMContentLoaded', async () => {
    let mySocketId = null;
    let myDeviceName = "Anonymous";
    let trustedDevices = [];
    let autoAcceptEnabled = false;

    // PORTABLE SETTINGS INITIALIZATION
    if (window.electronAPI) {
        const settings = await window.electronAPI.getSettings();
        myDeviceName = settings.deviceName;
        trustedDevices = settings.trustedDevices;
        autoAcceptEnabled = settings.autoAcceptEnabled;
    } else {
        myDeviceName = localStorage.getItem('localshare_device_name') || ("Device " + Math.floor(Math.random() * 1000));
        trustedDevices = JSON.parse(localStorage.getItem('localshare_trusted_devices') || '[]');
        autoAcceptEnabled = localStorage.getItem('localshare_auto_accept') === 'true';
        localStorage.setItem('localshare_device_name', myDeviceName);
    }

    const socket = io();
    let currentFiles = [];
    let currentDevices = [];

    function saveSettingLocal(key, val) {
        if (window.electronAPI) {
            window.electronAPI.updateSetting(key, val);
        } else {
            localStorage.setItem(`localshare_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}`, typeof val === 'object' ? JSON.stringify(val) : val);
        }
    }

    // Identity Settings
    const nameInput = document.getElementById('my-device-name');
    const nameSaveBtn = document.getElementById('save-device-name');
    nameInput.value = myDeviceName;
    document.getElementById('receive-device-name').textContent = myDeviceName;

    nameSaveBtn.addEventListener('click', () => {
        myDeviceName = nameInput.value.trim() || myDeviceName;
        saveSettingLocal('deviceName', myDeviceName);
        socket.emit('set_device_name', myDeviceName);
        nameSaveBtn.textContent = "Saved";
        document.getElementById('receive-device-name').textContent = myDeviceName;
        setTimeout(() => nameSaveBtn.textContent = "Rename Node", 2000);
    });

    // Desktop Settings Check & UI Adaptations
    const saveLocation = document.getElementById('save-location');
    const folderActions = document.getElementById('folder-actions');
    
    if (window.electronAPI) {
        window.electronAPI.getCurrentFolder().then(folder => { saveLocation.textContent = folder; });
        document.getElementById('change-folder-btn').addEventListener('click', async () => {
            const newFolder = await window.electronAPI.selectFolder();
            if (newFolder) { saveLocation.textContent = newFolder; loadFiles(); }
        });
    } else {
        saveLocation.textContent = "Default Browser 'Downloads' Directory";
        if (folderActions) {
            folderActions.innerHTML = "<p style='font-size:0.8rem; color:var(--text-muted);'>Mobile & Web browsers automatically save incoming files purely to your system Downloads directory for security reasons.</p>";
        }
    }
    
    // Diagnostic
    fetch('/api/ping').then(r => r.json()).then(p => console.log('Diagnostic Ping:', p)).catch(e => console.error('Ping Fail:', e));
 
     // Server Info
    fetch('/api/server-info')
        .then(res => res.json())
        .then(data => {
            const qrEl = document.getElementById('qr-code');
            const ipEl = document.getElementById('receive-device-ip');
            if (qrEl) qrEl.src = data.qrCodeDataUrl;
            try {
                const ip = data.url.split('://')[1].split(':')[0];
                if (ipEl) ipEl.textContent = ip;
            } catch (e) {}
        });

    socket.on('connect', () => {
        mySocketId = socket.id;
        const cn = document.getElementById('connection-info');
        if(cn) cn.style.opacity = '1';
        socket.emit('set_device_name', myDeviceName);
        loadFiles();
        navigateToHash(); 
    });

    socket.on('disconnect', () => {
        const cn = document.getElementById('connection-info');
        if(cn) cn.style.opacity = '0.5';
    });

    socket.on('device_list_update', devices => { 
        currentDevices = devices; 
        // Only trigger a silent UI update if we are actively looking at the Send page
        if (window.location.hash === '#send' && typeof renderNetworkPeers === 'function') {
            renderNetworkPeers();
        }
    });

    socket.on('transfer_progress', (data) => {
        const container = document.getElementById('receive-progress-container');
        const filenameLabel = document.getElementById('receive-filename');
        const progressFill = document.getElementById('receive-progress');
        const percentLabel = document.getElementById('receive-percentage');

        if (container && filenameLabel) {
            container.classList.remove('hidden');
            filenameLabel.textContent = `Receiving ${data.currentIndex + 1} / ${data.totalCount} - ${data.fileName}`;
            progressFill.style.width = data.percentage + '%';
            percentLabel.textContent = data.percentage + '%';

            // Update BOTH Global and Modal Queue UI
            const prefixes = ['', 'modal-'];
            prefixes.forEach(prefix => {
                const currentItem = document.getElementById(`${prefix}queue-item-${data.currentIndex}`);
                if (currentItem) {
                    const nameEl = currentItem.querySelector('.q-name') || currentItem.querySelector('span');
                    nameEl.style.opacity = '1';
                    nameEl.style.color = 'var(--primary)';
                    nameEl.style.fontWeight = '700';
                    
                    const statusLabel = currentItem.querySelector('.status-label');
                    statusLabel.textContent = data.percentage + '%';
                    statusLabel.style.color = 'var(--primary)';
                    
                    // Set "Next" label for the following item
                    const nextItem = document.getElementById(`${prefix}queue-item-${data.currentIndex + 1}`);
                    if (nextItem && data.percentage < 100) {
                        const nextLabel = nextItem.querySelector('.status-label');
                        if (nextLabel.textContent === 'Queued') {
                            nextLabel.textContent = 'Next';
                            nextLabel.style.color = 'var(--text-muted)';
                        }
                    }

                    // Mark as done
                    if (data.percentage === 100) {
                        nameEl.style.fontWeight = '500';
                        nameEl.style.color = 'var(--success)';
                        statusLabel.textContent = 'Done';
                        statusLabel.style.color = 'var(--success)';
                    }
                }
            });

            // If we have many files, use a generic title for the main bar
            if (data.totalCount > 1) {
                filenameLabel.textContent = `Processing ${data.totalCount} files...`;
            } else {
                filenameLabel.textContent = `Receiving ${data.fileName}`;
            }

            if (data.percentage >= 100 && data.currentIndex + 1 === data.totalCount) {
                setTimeout(() => {
                    container.classList.add('hidden');
                    if(receiveActions) receiveActions.classList.add('hidden');
                    if(!queueModal.classList.contains('hidden')) queueModal.classList.add('hidden');
                    currentIncomingQueue = []; 
                }, 2000);
            }
        }
    });

    socket.on('new_file', (fileInfo) => {
        loadFiles();
        // AUTO-DOWNLOAD IF DIRECTED TO THIS CLIENT (And not the desktop app itself)
        if (fileInfo.recipientId === mySocketId) {
            if (!window.electronAPI) {
                // Mobile/Web clients download into browser's folder
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = `/uploads/${fileInfo.name}`;
                a.download = fileInfo.originalName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } else {
                // Desktop app: File is already in the server's destination folder.
                // We just show a notification or toast.
                console.log("File saved to server destination folder:", fileInfo.originalName);
                if (typeof showToast === 'function') {
                    showToast(`File saved to ${saveLocation.textContent}`);
                }
            }
        }
    });

    // --- TRANSFER HANDSHAKE PROTOCOL ---
    const incomingModal = document.getElementById('incoming-modal');
    const trustCheckbox = document.getElementById('trust-device-checkbox');
    const queueModal = document.getElementById('queue-modal');
    const viewQueueBtn = document.getElementById('view-queue-btn');
    const receiveActions = document.getElementById('receive-actions');
    let currentIncomingQueue = [];
    
    socket.on('incoming_transfer', (req) => {
        currentIncomingQueue = req.fileNames || [];

        // AUTO-ACCEPT LOGIC
        const isTrusted = trustedDevices.includes(req.senderId);
        if (isTrusted && autoAcceptEnabled) {
            console.log("Auto-accepting transfer from trusted device:", req.senderName);
            socket.emit('transfer_response', { targetId: req.senderId, accepted: true });
            
            // UI Update for Recipient on Auto-Accept
            const receiveProgressCont = document.getElementById('receive-progress-container');
            if (receiveProgressCont) receiveProgressCont.classList.remove('hidden');
            if (receiveActions) receiveActions.classList.remove('hidden');
            
            renderQueueUI();
            showToast(`Auto-accepting ${req.fileCount} file(s) from ${req.senderName}`);
            return;
        }

        document.getElementById('incoming-sender').textContent = req.senderName;
        document.getElementById('incoming-details').textContent = `${req.fileCount} file(s) (${formatBytes(req.totalSize)})`;
        incomingModal.classList.remove('hidden');
        incomingModal.dataset.senderId = req.senderId;
        if(trustCheckbox) trustCheckbox.checked = false; 
    });

    document.getElementById('accept-transfer-btn').addEventListener('click', () => {
        const id = incomingModal.dataset.senderId;
        
        // Handle Trust Device
        if (trustCheckbox && trustCheckbox.checked) {
            if (!trustedDevices.includes(id)) {
                trustedDevices.push(id);
                saveSettingLocal('trustedDevices', trustedDevices);
            }
        }

        socket.emit('transfer_response', { targetId: id, accepted: true });
        incomingModal.classList.add('hidden');
        
        // Initial queue rendering (Both Global and Modal)
        renderQueueUI();
        document.getElementById('receive-progress-container').classList.remove('hidden');
        if(receiveActions) receiveActions.classList.remove('hidden');
    });

    function renderQueueUI() {
        const containers = [
            document.getElementById('receive-queue'),
            document.getElementById('modal-queue-list')
        ];

        containers.forEach(container => {
            if (!container) return;
            container.innerHTML = '';
            const isModal = container.id === 'modal-queue-list';
            
            currentIncomingQueue.forEach((name, idx) => {
                const item = document.createElement('div');
                item.id = `${isModal ? 'modal-' : ''}queue-item-${idx}`;
                item.className = 'queue-row';
                item.style.cssText = `display:flex; justify-content:space-between; padding:${isModal ? '12px 14px' : '2px 0'}; ${isModal ? 'background:var(--hover-bg); margin-bottom:8px; border-radius:8px;' : ''}`;
                item.innerHTML = `
                    <span class="q-name" style="opacity:0.6; ${isModal ? 'font-weight:500; font-size:0.9rem;' : ''}">${idx+1}. ${name}</span>
                    <span class="status-label" style="font-size:0.7rem; font-weight:600; text-transform:uppercase;">Queued</span>
                `;
                container.appendChild(item);
            });
        });
    }

    viewQueueBtn.addEventListener('click', () => queueModal.classList.remove('hidden'));
    document.getElementById('close-queue-btn').addEventListener('click', () => queueModal.classList.add('hidden'));
    document.getElementById('dismiss-queue-btn').addEventListener('click', () => queueModal.classList.add('hidden'));

    document.getElementById('decline-transfer-btn').addEventListener('click', () => {
        const id = incomingModal.dataset.senderId;
        socket.emit('transfer_response', { targetId: id, accepted: false });
        incomingModal.classList.add('hidden');
    });

    socket.on('transfer_response', (res) => {
        if (res.accepted) {
            if (window.processAcceptedTransfer) window.processAcceptedTransfer();
        } else {
            const upName = document.getElementById('upload-filename');
            const pCont = document.getElementById('upload-progress-container');
            if(upName) upName.textContent = "Transfer Declined by recipient.";
            if(pCont) setTimeout(() => { pCont.classList.add('hidden'); }, 3000);
        }
    });


    // PAGE NAVIGATION LOGIC WITH HASH PERSISTENCE
    const navItems = document.querySelectorAll('.nav-item');
    const pages = document.querySelectorAll('.page');
    const pageTitle = document.getElementById('page-title');
    const globalSearch = document.getElementById('global-search-container');

    function navigateToHash() {
        let hash = window.location.hash || '#dashboard';
        const targetLink = document.querySelector(`.nav-item[href="${hash}"]`);
        if (targetLink) {
            navItems.forEach(n => n.classList.remove('active'));
            targetLink.classList.add('active');
            
            const targetId = targetLink.getAttribute('data-page');
            pages.forEach(p => {
                if (p.id === targetId) { p.classList.remove('hidden'); p.classList.add('active'); } 
                else { p.classList.add('hidden'); p.classList.remove('active'); }
            });

            pageTitle.textContent = targetLink.dataset.title;
            if (targetId === 'page-history') globalSearch.classList.remove('hidden');
            else globalSearch.classList.add('hidden');

            // --- AUTO SCAN ON SEND TAB ---
            if (targetId === 'page-send') {
                setTimeout(() => {
                    const btn = document.getElementById('inline-scan-btn');
                    if (btn && !btn.disabled) btn.click();
                }, 100);
                
                // Set up background refresh while active
                if (window.sendInterval) clearInterval(window.sendInterval);
                window.sendInterval = setInterval(() => {
                    if (window.location.hash === '#send') {
                        socket.emit('request_device_list');
                        // No need to click the UI button (which pulses/clears), 
                        // just refreshing device list in background via socket is enough,
                        // then we re-render silently if needed.
                        // Actually, clicking is better as it provides visual feedback of fresh results.
                        const btn = document.getElementById('inline-scan-btn');
                        if (btn && !btn.disabled && !globallyStagedFiles.length) {
                             // Only auto-click if user isn't actively busy with staging
                        }
                    } else {
                        clearInterval(window.sendInterval);
                    }
                }, 15000);
            } else {
                if (window.sendInterval) clearInterval(window.sendInterval);
            }
        }
    }
    window.addEventListener('hashchange', navigateToHash);

    // MOBILE SIDEBAR TOGGLE
    const sidebar = document.querySelector('.sidebar');
    const menuToggle = document.getElementById('mobile-menu-toggle');
    
    const autoAcceptToggle = document.getElementById('auto-accept-toggle');
    if (autoAcceptToggle) {
        autoAcceptToggle.checked = autoAcceptEnabled;
        autoAcceptToggle.addEventListener('change', (e) => {
            autoAcceptEnabled = e.target.checked;
            saveSettingLocal('autoAcceptEnabled', autoAcceptEnabled);
        });
    }
    
    // Electron Settings
    if (window.electronAPI) {
        const startHiddenToggle = document.getElementById('start-hidden-toggle');
        window.electronAPI.getSettings().then(settings => {
            if (startHiddenToggle) {
                startHiddenToggle.checked = settings.startHidden === true;
                startHiddenToggle.addEventListener('change', (e) => {
                    window.electronAPI.updateSetting('startHidden', e.target.checked);
                    showToast(e.target.checked ? "App will start minimized to tray." : "App will open normally on launch.");
                });
            }
        });
    } else {
        // Hide the toggle if not running in Electron
        const startHiddenRow = document.getElementById('start-hidden-row');
        if (startHiddenRow) startHiddenRow.classList.add('hidden');
    }

    if (menuToggle) {
        menuToggle.addEventListener('click', () => sidebar.classList.toggle('open') );
    }
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 768) sidebar.classList.remove('open');
        });
    });

    // SEND PAGE WIDGET LOGIC
    const modeFilesBtn = document.getElementById('mode-files-btn');
    const modeMediaBtn = document.getElementById('mode-media-btn');
    const modeTextBtn = document.getElementById('mode-text-btn');
    const modeLinkBtn = document.getElementById('mode-link-btn');

    const stagingFilesArea = document.getElementById('staging-files-area');
    const stagingTextArea = document.getElementById('staging-text-area');
    
    const addFilesBtn = document.getElementById('add-files-btn');
    const pasteClipboardBtn = document.getElementById('paste-clipboard-btn');
    const fileInput = document.getElementById('file-input');
    const stagedFilesList = document.getElementById('staged-files-list');
    const stagedFilesSummary = document.getElementById('staged-files-summary');
    const textInput = document.getElementById('text-input');

    const inlineScanBtn = document.getElementById('inline-scan-btn');
    const inlineScanArea = document.getElementById('inline-scan-area');
    const inlineDeviceResults = document.getElementById('inline-device-results');
    const progressContainer = document.getElementById('upload-progress-container');
    
    let selectedMode = 'files'; // files | media | text | link
    let globallyStagedFiles = [];
    let selectedRecipientId = null;
    let selectedRecipientName = null;
    let selectedRecipientIsRemote = false;
    let selectedRecipientAddress = null; // 'ip:port'

    const updateSelectedMode = (mode) => {
        selectedMode = mode;
        const allModeBtns = [modeFilesBtn, modeMediaBtn, modeTextBtn, modeLinkBtn];
        allModeBtns.forEach(b => { b?.classList.remove('btn-primary'); b?.classList.add('btn-outline'); });

        const activeBtn = { files: modeFilesBtn, media: modeMediaBtn, text: modeTextBtn, link: modeLinkBtn }[mode];
        activeBtn?.classList.remove('btn-outline');
        activeBtn?.classList.add('btn-primary');

        if (mode === 'files' && fileInput) fileInput.removeAttribute('accept');
        if (mode === 'media' && fileInput) fileInput.setAttribute('accept', 'image/*,video/*');

        if (mode === 'text' || mode === 'link') {
            stagingFilesArea?.classList.add('hidden');
            stagingTextArea?.classList.remove('hidden');
            textInput.placeholder = mode === 'link' ? "Paste a web link (URL) here..." : "Type or paste a message or clipboard data here...";
        } else {
            stagingFilesArea?.classList.remove('hidden');
            stagingTextArea?.classList.add('hidden');
        }
    };

    modeFilesBtn?.addEventListener('click', () => { updateSelectedMode('files'); fileInput.click(); });
    modeMediaBtn?.addEventListener('click', () => { updateSelectedMode('media'); fileInput.click(); });
    modeTextBtn?.addEventListener('click', () => updateSelectedMode('text'));
    modeLinkBtn?.addEventListener('click', () => updateSelectedMode('link'));

    addFilesBtn?.addEventListener('click', () => fileInput.click());
    fileInput?.addEventListener('change', () => {
        for (const file of fileInput.files) {
            if (!globallyStagedFiles.find(f => f.name === file.name && f.size === file.size)) {
                globallyStagedFiles.push(file);
            }
        }
        renderStagedFiles();
        fileInput.value = ''; // Reset for same-file re-selection
    });

    pasteClipboardBtn?.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                updateSelectedMode(text.startsWith('http') ? 'link' : 'text');
                textInput.value = text;
                showToast("Pasted from clipboard");
            }
        } catch (e) {
            showToast("Clipboard access denied");
        }
    });

    function renderStagedFiles() {
        if (!stagedFilesList) return;
        stagedFilesList.innerHTML = '';
        let totalSize = 0;
        globallyStagedFiles.forEach((file, index) => {
            totalSize += file.size;
            const item = document.createElement('div');
            item.className = 'staged-file-item';
            item.style.cssText = 'display:flex; align-items:center; gap:12px; background:var(--sidebar-bg); padding:10px 14px; border-radius:8px;';
            item.innerHTML = `
                <div style="font-size:1.2rem;">${file.type.startsWith('image/') ? '🖼️' : '📄'}</div>
                <div style="flex:1; overflow:hidden;">
                    <div style="font-weight:600; font-size:0.9rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${file.name}</div>
                    <div style="font-size:0.75rem; color:var(--text-muted);">${formatBytes(file.size)}</div>
                </div>
                <button class="remove-file-btn" data-index="${index}" style="background:none; border:none; color:var(--pdf-color); cursor:pointer; padding:4px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            `;
            stagedFilesList.appendChild(item);
        });

        if (stagedFilesSummary) {
            stagedFilesSummary.textContent = globallyStagedFiles.length > 0 
                ? `${globallyStagedFiles.length} file(s) staged (${formatBytes(totalSize)})`
                : '';
        }

        stagedFilesList.querySelectorAll('.remove-file-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.currentTarget.dataset.index);
                globallyStagedFiles.splice(idx, 1);
                renderStagedFiles();
            });
        });
    }

    function renderNetworkPeers() {
        if (!inlineDeviceResults) return;
        
        // Don't disturb if user is in an active scanning animation unless we really need to
        if (!inlineScanArea.classList.contains('hidden')) return;

        inlineDeviceResults.innerHTML = '';
        currentDevices.forEach(d => {
            if (d.id !== mySocketId) {
                const isRemote = d.isRemoteHub;
                const shortId = isRemote ? `${d.ip}:${d.port}` : d.id.substring(0, 8).toUpperCase();
                const card = document.createElement('div');
                card.className = 'device-card';
                card.dataset.id = d.id;
                card.dataset.name = d.name;
                card.dataset.remote = isRemote ? 'true' : 'false';
                card.dataset.address = isRemote ? `${d.ip}:${d.port}` : '';
                
                card.innerHTML = `
                    <div class="device-avatar">${isRemote ? '🖥️' : '📱'}</div>
                    <div class="device-info">
                        <span class="device-n">${d.name} ${isRemote ? '<small style="color:var(--success); font-weight:700;">HUB</small>' : ''}</span>
                        <span class="device-id">${isRemote ? d.ip : 'ID: ' + shortId}</span>
                    </div>`;
                inlineDeviceResults.appendChild(card);
            }
        });

        if (inlineDeviceResults.children.length === 0) {
            inlineDeviceResults.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding: 20px;">No other devices detected on network (${currentDevices.length} node(s) connected to local server).</div>`;
        } else {
            inlineDeviceResults.classList.remove('hidden');
        }

        inlineDeviceResults.querySelectorAll('.device-card').forEach(card => {
            card.addEventListener('click', () => {
                selectedRecipientId = card.dataset.id;
                selectedRecipientName = card.dataset.name;
                selectedRecipientIsRemote = card.dataset.remote === 'true';
                selectedRecipientAddress = card.dataset.address;
                initiateTransferProcess();
            });
        });
    }

    // DRAG AND DROP SUPPORT
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (window.location.hash !== '#send') {
            window.location.hash = '#send';
        }

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            updateSelectedMode('files');
            for (const file of e.dataTransfer.files) {
                if (!globallyStagedFiles.find(f => f.name === file.name && f.size === file.size)) {
                    globallyStagedFiles.push(file);
                }
            }
            renderStagedFiles();
        }
    });

    inlineScanBtn?.addEventListener('click', () => {
        inlineScanArea?.classList.remove('hidden');
        inlineDeviceResults?.classList.add('hidden');
        inlineScanBtn.disabled = true;
        inlineScanBtn.textContent = "Scanning...";
        
        socket.emit('request_device_list');
        
        setTimeout(() => {
            inlineScanArea?.classList.add('hidden');
            inlineScanBtn.disabled = false;
            inlineScanBtn.textContent = "Scan Network";
            renderNetworkPeers();
        }, 2000);
    });

    async function initiateTransferProcess() {
        if (!selectedRecipientId) return;

        let totalSize = 0; let fileNames = [];
        let fileCount = 0;

        if (selectedMode === 'files' || selectedMode === 'media') {
            if (globallyStagedFiles.length === 0) {
                alert(`Please stage ${selectedMode === 'media' ? 'media' : 'files'} first.`);
                return;
            }
            fileCount = globallyStagedFiles.length;
            globallyStagedFiles.forEach(f => { totalSize += f.size; fileNames.push(f.name); });
        } else {
            const rawText = textInput.value.trim();
            if (!rawText) {
                alert(`Please enter a ${selectedMode === 'link' ? 'Web Link' : 'Text Snippet'}.`);
                return;
            }
            fileCount = 1;
            totalSize = new Blob([rawText]).size;
            fileNames = [selectedMode === 'link' ? '🔗 URL Link' : '💬 Text Snippet'];
        }

        showWaitingUI();

        if (selectedRecipientIsRemote) {
            // --- HUB-TO-HUB REST HANDSHAKE ---
            try {
                const sessionId = Date.now().toString();
                window.currentRemoteSessionId = sessionId; // Store for progress updates
                
                const res = await fetch(`http://${selectedRecipientAddress}/api/remote/handshake`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sessionId: sessionId,
                        senderName: myDeviceName,
                        fileCount: fileCount,
                        totalSize: totalSize,
                        fileNames: fileNames,
                        payloadType: selectedMode
                    })
                });
                
                const data = await res.json();
                if (data.accepted) {
                    processAcceptedTransfer();
                } else {
                    handleDeclinedTransfer();
                }
            } catch (err) {
                console.error("Remote Handshake failed:", err);
                handleDeclinedTransfer("Connection failed or timed out.");
            }

        } else {
            // --- LOCAL SOCKET HANDSHAKE ---
            socket.emit('request_transfer', {
                targetId: selectedRecipientId,
                senderName: myDeviceName,
                fileCount: fileCount,
                totalSize: totalSize,
                fileNames: fileNames,
                payloadType: selectedMode
            });
        }
    }

    function handleDeclinedTransfer(msg = "Transfer Declined by recipient.") {
        const upName = document.getElementById('upload-filename');
        const pCont = document.getElementById('upload-progress-container');
        if(upName) upName.textContent = msg;
        if(pCont) setTimeout(() => { pCont.classList.add('hidden'); }, 3000);
    }

    function showWaitingUI() {
        progressContainer.classList.remove('hidden');
        document.getElementById('upload-filename').textContent = "Waiting for " + selectedRecipientName + " to accept...";
        document.getElementById('upload-progress').style.width = '100%';
        document.getElementById('upload-progress').style.background = 'var(--text-muted)';
        document.getElementById('upload-percentage').textContent = "";
    }

    window.processAcceptedTransfer = function() {
        if (selectedMode === 'files' || selectedMode === 'media') {
            document.getElementById('upload-progress').style.background = 'var(--primary)';
            uploadFilesConcurrent(globallyStagedFiles).then(() => {
                globallyStagedFiles = [];
                renderStagedFiles();
            });
        } else {
            document.getElementById('upload-progress').style.background = 'var(--primary)';
            uploadTextSnippet(textInput.value).then(() => {
                textInput.value = '';
            });
        }
    };

    async function uploadFilesConcurrent(files) {
        const concurrency = 3;
        const queue = [...files];
        const workers = [];
        
        // Use an index-based tracker to map original indices correctly
        const fileEntries = files.map((f, i) => ({ file: f, index: i }));
        let currentIndex = 0;

        async function worker() {
            while (currentIndex < fileEntries.length) {
                const entry = fileEntries[currentIndex++];
                if (!entry) break;
                await uploadSingleFilePromise(entry.file, entry.index, files.length);
            }
        }

        for (let i = 0; i < Math.min(concurrency, files.length); i++) {
            workers.push(worker());
        }

        await Promise.all(workers);
        finishUploadSequence();
    }

    function uploadTextSnippet(text) {
        return new Promise((resolve) => {
            document.getElementById('upload-filename').textContent = `Transmitting payload...`;
            document.getElementById('upload-progress').style.width = '100%';
            
            const endpoint = selectedRecipientIsRemote 
                ? `http://${selectedRecipientAddress}/api/remote/upload-text`
                : '/api/upload-text';

            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    senderId: mySocketId,
                    senderName: myDeviceName,
                    recipientId: selectedRecipientId,
                    recipientName: selectedRecipientName,
                    textContent: text,
                    payloadType: selectedMode
                })
            }).then(() => {
                const progData = {
                    targetId: selectedRecipientId,
                    fileName: selectedMode === 'link' ? 'URL Link' : 'Text Message',
                    percentage: 100,
                    currentIndex: 0,
                    totalCount: 1
                };

                if (selectedRecipientIsRemote) {
                    fetch(`http://${selectedRecipientAddress}/api/remote/progress`, {
                        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(progData)
                    });
                } else {
                    socket.emit('transfer_progress', progData);
                }
                
                finishUploadSequence();
                resolve();
            });
        });
    }

    function finishUploadSequence() {
        setTimeout(() => {
            progressContainer.classList.add('hidden');
            loadFiles(); 
        }, 1000);
    }

    function uploadSingleFilePromise(file, index, total) {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('senderId', mySocketId);
            formData.append('senderName', myDeviceName);
            formData.append('recipientId', selectedRecipientId);
            formData.append('recipientName', selectedRecipientName);

            const uploadLabel = document.getElementById('upload-filename');
            if (total > 1) {
                uploadLabel.textContent = `Processing ${total} files...`;
            } else {
                uploadLabel.textContent = `Uploading ${file.name}`;
            }
            
            document.getElementById('upload-progress').style.width = '0%';
            document.getElementById('upload-percentage').textContent = '0%';

            const xhr = new XMLHttpRequest();
            xhr.upload.addEventListener('progress', e => {
                if (e.lengthComputable) {
                    const p = Math.round((e.loaded / e.total) * 100);
                    document.getElementById('upload-progress').style.width = p + '%';
                    document.getElementById('upload-percentage').textContent = p + '%';
                    
                    const progData = {
                        targetId: selectedRecipientId,
                        fileName: file.name,
                        percentage: p,
                        currentIndex: index,
                        totalCount: total
                    };

                    // Broadcast progress to recipient
                    if (selectedRecipientIsRemote) {
                        fetch(`http://${selectedRecipientAddress}/api/remote/progress`, {
                            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(progData)
                        }).catch(()=>{}); // Ignore network errors on rapid progress updates
                    } else {
                        socket.emit('transfer_progress', progData);
                    }
                }
            });
            xhr.onload = () => {
                if (xhr.status === 200) resolve();
                else reject(xhr.responseText);
            };
            xhr.onerror = () => reject('Network error');
            
            const endpoint = selectedRecipientIsRemote 
                ? `http://${selectedRecipientAddress}/api/remote/upload`
                : '/api/upload';
            
            xhr.open('POST', endpoint, true);
            xhr.send(formData);
        });
    }

    // STATS AND HISTORY LOGIC
    const HISTORY_TTL_MS = 10000; // 10 seconds
    let historyExpireTimer = null;

    function getVisibleFiles(files) {
        const now = Date.now();
        return files.filter(f => (now - new Date(f.date).getTime()) < HISTORY_TTL_MS);
    }

    function scheduleHistoryExpiry(files) {
        if (historyExpireTimer) clearTimeout(historyExpireTimer);
        const now = Date.now();
        const soonest = files.reduce((min, f) => {
            const age = now - new Date(f.date).getTime();
            const remaining = HISTORY_TTL_MS - age;
            return remaining > 0 ? Math.min(min, remaining) : min;
        }, Infinity);
        if (soonest < Infinity) {
            historyExpireTimer = setTimeout(() => {
                const visible = getVisibleFiles(currentFiles);
                renderFiles(visible, document.getElementById('files-list'));
                const recent = visible.slice(0, 5);
                renderFiles(recent, document.getElementById('dashboard-recent-list'), true);
                updateDashboardStats(visible);
                scheduleHistoryExpiry(currentFiles);
            }, soonest + 50);
        }
    }

    function loadFiles() {
        if (!mySocketId) return;
        fetch(`/api/files?socketId=${mySocketId}`)
            .then(res => res.json())
            .then(files => {
                currentFiles = files;
                const visible = getVisibleFiles(files);
                updateDashboardStats(visible);
                renderFiles(visible, document.getElementById('files-list'));
                const recent = visible.slice(0, 5);
                renderFiles(recent, document.getElementById('dashboard-recent-list'), true);
                scheduleHistoryExpiry(files);
            });
    }

    function updateDashboardStats(files) {
        let sentCount = 0; let receiveCount = 0; let totalBytes = 0;
        files.forEach(f => {
            totalBytes += f.size;
            if (f.sender && f.sender.id === mySocketId) sentCount++;
            else receiveCount++; 
        });
        
        const elSent = document.getElementById('stat-sent');
        const elRec = document.getElementById('stat-received');
        const elTotal = document.getElementById('stat-total');

        if(elSent) elSent.textContent = sentCount;
        if(elRec) elRec.textContent = receiveCount;
        if(elTotal) elTotal.textContent = formatBytes(totalBytes);
    }

    // SHARED FILE RENDERER
    const template = document.getElementById('file-item-template');
    const ctxMenu = document.getElementById('context-menu');
    const ctxDownload = document.getElementById('ctx-download');
    
    document.getElementById('list-view-btn').addEventListener('click', e => {
        e.currentTarget.classList.add('active'); 
        document.getElementById('grid-view-btn').classList.remove('active');
        document.getElementById('files-list').className = 'files-container list-view';
        document.getElementById('list-header').classList.remove('hidden');
        renderFiles(currentFiles, document.getElementById('files-list'));
    });

    document.getElementById('grid-view-btn').addEventListener('click', e => {
        e.currentTarget.classList.add('active'); 
        document.getElementById('list-view-btn').classList.remove('active');
        document.getElementById('files-list').className = 'files-container grid-view';
        document.getElementById('list-header').classList.add('hidden');
        renderFiles(currentFiles, document.getElementById('files-list'));
    });

    document.getElementById('search-input').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        renderFiles(currentFiles.filter(f => f.originalName.toLowerCase().includes(query)), document.getElementById('files-list'));
    });
    document.getElementById('refresh-btn').addEventListener('click', loadFiles);

    document.getElementById('open-folder-btn').addEventListener('click', () => {
        if (window.electronAPI) {
            window.electronAPI.openFolder();
        } else {
            showToast('Open your Downloads/LocalShare folder to find your files.');
        }
    });

    document.getElementById('clear-history-btn').addEventListener('click', () => {
        if (confirm("Are you sure you want to clear your transfer history? This only removes the records from this list; your physical files will remain safely in your storage folder.")) {
            fetch('/api/clear-history', { method: 'POST' })
                .then(res => res.json())
                .then(data => {
                    if (data.success) {
                        showToast("Transfer history cleared.");
                        loadFiles();
                    }
                })
                .catch(err => {
                    console.error("Clear history failed:", err);
                    showToast("Failed to clear history.");
                });
        }
    });

    function renderFiles(files, container) {
        if (!container) return;
        container.innerHTML = '';
        if (files.length === 0) {
            container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted)">No files to display.</div>';
            return;
        }

        const isGrid = container.classList.contains('grid-view');

        files.forEach(file => {
            const clone = template.content.cloneNode(true);
            const fileUrl = `/uploads/${file.name}`;
            const extMatch = file.originalName.match(/\.([0-9a-z]+)(?:[\?#]|$)/i);
            const ext = extMatch ? extMatch[1].toLowerCase() : '';

            clone.querySelector('.file-name').textContent = file.originalName;
            clone.querySelector('.file-size').textContent = formatBytes(file.size);
            clone.querySelector('.file-date').textContent = formatDate(new Date(file.date));

            const badge = clone.querySelector('.privacy-badge');
            if (file.sender && file.sender.id === mySocketId) {
                badge.classList.add('sent'); badge.textContent = `Sent to ${file.recipientName || 'Device'}`;
            } else {
                badge.classList.add('private');
                if (file.sender) badge.textContent = `From ${file.sender.name}`;
                else badge.textContent = `From device`;
            }

            const gridArea = clone.querySelector('.file-icon-area');
            const listArea = clone.querySelector('.list-thumbnail');
            let previewEl = '';

            if (file.type === 'image') previewEl = `<img src="${fileUrl}" loading="lazy" style="width:100%;height:100%;object-fit:cover;">`;
            else if (file.type === 'video') previewEl = `<video src="${fileUrl}" preload="metadata" muted loop onmouseover="this.play()" onmouseout="this.pause()" style="width:100%;height:100%;object-fit:cover;"></video>`;
            else if (file.type === 'audio') {
                if (isGrid) previewEl = `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; height:100%;"><audio src="${fileUrl}" controls style="width:90%;"></audio></div>`;
                else previewEl = getSvgIconForExt(ext);
            } else previewEl = getSvgIconForExt(ext);

            if (isGrid) gridArea.innerHTML = previewEl;
            else listArea.innerHTML = previewEl;

            const dotsBtn = clone.querySelector('.dots-btn');
            dotsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const rect = dotsBtn.getBoundingClientRect();
                ctxMenu.style.left = `${Math.min(rect.x - 140, window.innerWidth - 180)}px`;
                ctxMenu.style.top = `${rect.bottom + 5}px`;
                ctxMenu.classList.remove('hidden');
                ctxDownload.href = fileUrl;
                ctxDownload.download = file.originalName;
            });
            container.appendChild(clone);
        });
    }

    document.addEventListener('click', (e) => {
        if (!ctxMenu.contains(e.target)) ctxMenu.classList.add('hidden');
    });

    function getSvgIconForExt(ext) {
        let color = '#546e7a'; let svgPath = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path>';
        if (['mp3', 'wav', 'flac'].includes(ext)) { color = '#ba68c8'; svgPath = '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>'; }
        else if (['pdf'].includes(ext)) { color = '#e53935'; svgPath = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M16 13H8"></path><path d="M16 17H8"></path><path d="M10 9H8"></path>'; }
        else if (['zip', 'rar'].includes(ext)) { color = '#8d6e63'; svgPath = '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><circle cx="12" cy="14" r="2"></circle><path d="M12 9v3"></path>'; }
        return `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%;">${svgPath}</svg>`;
    }

    function formatBytes(bytes) {
        if (!+bytes) return '0 B';
        const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    }

    function formatDate(date) {
        const isToday = date.toDateString() === new Date().toDateString();
        return isToday ? date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : `${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()}`;
    }

    // TOAST NOTIFICATION SYSTEM
    function showToast(message) {
        let toast = document.getElementById('app-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'app-toast';
            toast.className = 'toast hidden';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.remove('hidden');
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.classList.add('hidden'), 300);
        }, 3000);
    }

    // PWA INSTALL PROMPT
    let deferredInstallPrompt = null;
    const pwaInstallBtn = document.getElementById('pwa-install-btn');

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        if (pwaInstallBtn) pwaInstallBtn.classList.remove('hidden');
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        if (pwaInstallBtn) pwaInstallBtn.classList.add('hidden');
    });

    pwaInstallBtn?.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (outcome === 'accepted') pwaInstallBtn.classList.add('hidden');
    });
});
