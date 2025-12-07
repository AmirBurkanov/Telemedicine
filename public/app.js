// public/app.js
const socket = io();

// --- UI Elements ---
const connStatus = document.getElementById('conn-status');
const userSelect = document.getElementById('userSelect');
const startCallBtn = document.getElementById('startCall');
const endCallBtn = document.getElementById('endCall');
const toggleMicBtn = document.getElementById('toggleMic');
const toggleCamBtn = document.getElementById('toggleCam');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

// --- State ---
let localStream = null;
let peerConnection = null;
let dataChannel = null;
let remoteStream = null;
let currentTarget = null;
let isInitiator = false;
let callPending = false; 

// !!! МАКСИМАЛЬНЫЙ СПИСОК БЕСПЛАТНЫХ STUN-СЕРВЕРОВ !!!
const rtcConfig = {
  iceServers: [
    // Google (наиболее надежные)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    
    // Mozilla
    { urls: 'stun:stun.services.mozilla.com' },
    
    // Другие общедоступные
    { urls: 'stun:stun.stunprotocol.org' },
    { urls: 'stun:stunserver.org' },
    { urls: 'stun:stun.voip.blackberry.com:3478' }
    // ВНИМАНИЕ: Для 100% надежности необходим платный TURN-сервер!
  ]
};

// --- Helpers ---
function logChat(text) {
  const div = document.createElement('div');
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setStatus(s) {
  connStatus.textContent = s;
}

// --- Media ---
async function getLocalMedia() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    return localStream;
  } catch (err) {
    console.error('getUserMedia error', err);
    alert('Ошибка доступа к камере/микрофону: ' + (err.message || err));
    throw err;
  }
}

// --- PeerConnection ---
function createPeerConnection(targetId) {
  currentTarget = targetId;
  
  if (peerConnection) {
      console.warn('PeerConnection уже существует, закрываем старое.');
      peerConnection.close();
  }
  
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Добавляем локальные дорожки
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    console.log('Локальные дорожки добавлены в PeerConnection.');
  }

  // ICE кандидаты
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && currentTarget) {
      console.log('Отправка ICE кандидата:', event.candidate);
      socket.emit('signal', { type: 'candidate', candidate: event.candidate, target: currentTarget });
    }
  };

  // Получение удаленных треков (исправлено)
  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteStream = event.streams[0];
            remoteVideo.srcObject = remoteStream;
            console.log('Удаленный поток установлен в remoteVideo.');
        }
    } else {
        if (!remoteStream) {
          remoteStream = new MediaStream();
          remoteVideo.srcObject = remoteStream;
        }
        remoteStream.addTrack(event.track);
    }
  };

  // DataChannel от принимающей стороны
  peerConnection.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };

  // Соединение закрыто (или не установлено)
  peerConnection.onconnectionstatechange = () => {
    console.log('PC state changed to:', peerConnection.connectionState);
    if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
      cleanupCall();
    }
  };
}

// --- DataChannel ---
function setupDataChannel() {
  if (!dataChannel) return;
  dataChannel.onopen = () => logChat('Система: DataChannel открыт');
  dataChannel.onmessage = (e) => logChat('Собеседник: ' + e.data);
  dataChannel.onclose = () => logChat('Система: DataChannel закрыт');
}

// --- Signaling ---
socket.on('connect', () => {
  setStatus('online');
  console.log('Connected, id=', socket.id);
});

socket.on('disconnect', () => setStatus('offline'));

socket.on('users', (users) => {
  userSelect.innerHTML = '<option value="">-- Выберите пользователя --</option>';
  users.forEach(id => {
    if (id === socket.id) return;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    userSelect.appendChild(opt);
  });
});

// 1. Получение входящего запроса (Принимающая сторона)
socket.on('call-request', ({ sender }) => {
    if (peerConnection || callPending) {
        socket.emit('call-response', { target: sender, action: 'reject' });
        logChat(`Система: Пропущен входящий звонок от ${sender}. Пользователь занят.`);
        return;
    }
    
    currentTarget = sender;
    callPending = true; 
    logChat(`Система: Входящий звонок от ${sender}. Автоматическое принятие через 3 секунды (для теста)...`);
    
    // Эмуляция автоматического принятия для простоты (замените на UI)
    setTimeout(() => {
        if (callPending && currentTarget === sender) {
            logChat('Система: Вызов принят (автоматически).');
            socket.emit('call-response', { target: sender, action: 'accept' });
        }
    }, 3000);
});

// 2. Получение ответа на запрос (Инициатор)
socket.on('call-response', async ({ sender, action }) => {
    
    if (sender !== currentTarget || !callPending) return;

    callPending = false;
    startCallBtn.disabled = false;
    
    if (action === 'accept') {
        logChat('Система: Вызов принят. Запуск WebRTC (отправка OFFER)...');
        
        try {
            await getLocalMedia();
            createPeerConnection(currentTarget);
            isInitiator = true;

            dataChannel = peerConnection.createDataChannel('chat');
            setupDataChannel();

            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('signal', { type: 'offer', sdp: offer, target: currentTarget });
            
        } catch (err) {
            console.error('Ошибка инициации WebRTC:', err);
            cleanupCall();
        }
        
    } else { // action === 'reject'
        logChat(`Система: Вызов отклонен пользователем ${sender}.`);
        currentTarget = null;
    }
});


// Обработка сигналов WebRTC (OFFER/ANSWER/CANDIDATE)
socket.on('signal', async (data) => {
  const sender = data.sender;
  try {
    if (data.type === 'offer') {
      console.log('Получен OFFER от', sender);
      
      await getLocalMedia();
      if (!peerConnection || currentTarget !== sender) {
          createPeerConnection(sender); 
      }
      isInitiator = false;

      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', sdp: answer, target: sender });
      console.log('Отправлен ANSWER');

    } else if (data.type === 'answer') {
      if (!peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

    } else if (data.type === 'candidate') {
      if (!peerConnection || !peerConnection.remoteDescription) return;
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (err) {
    console.error('Ошибка обработки сигнала', err);
  }
});

// Резервный чат через Socket.io
socket.on('chat', ({ sender, message }) => {
  logChat('Другой: ' + message);
});

// --- UI Actions ---
startCallBtn.addEventListener('click', async () => {
  const target = userSelect.value;
  if (!target) return alert('Выберите пользователя для звонка');
  if (callPending || peerConnection) return alert('Уже идет или ожидается другой вызов.');

  currentTarget = target; 
  callPending = true;
  startCallBtn.disabled = true;
  logChat(`Система: Отправка запроса на вызов пользователю ${target}...`);
  socket.emit('call-request', { target: target }); 
});

endCallBtn.addEventListener('click', cleanupCall);

function cleanupCall() {
  if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
  }
  dataChannel = null;
  remoteStream = null;
  remoteVideo.srcObject = null;
  currentTarget = null;
  isInitiator = false;
  callPending = false;
  startCallBtn.disabled = false;
  logChat('Система: звонок завершён');
}

// Микрофон
toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const at = localStream.getAudioTracks()[0];
  if (at) {
    at.enabled = !at.enabled;
    toggleMicBtn.textContent = at.enabled ? 'Выкл/Вкл микрофон' : 'Вкл/Выкл микрофон';
  }
});

// Камера
toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const vt = localStream.getVideoTracks()[0];
  if (vt) {
    vt.enabled = !vt.enabled;
    toggleCamBtn.textContent = vt.enabled ? 'Выкл/Вкл камеру' : 'Вкл/Выкл камеру';
  }
});

// Чат
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  logChat('Я: ' + text);

  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(text);
  } else if (currentTarget) {
    socket.emit('chat', { target: currentTarget, message: text });
  } else {
    logChat('Система: нет активного собеседника для отправки сообщения');
  }
});

async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('Devices:', devices);
  } catch (err) {
    console.warn('enumerateDevices error', err);
  }
}
listDevices();
