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

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
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

  // Добавляем локальные дорожки, если localStream уже получен
  if (localStream) {
    localStream.getTracks().forEach(track => {
      // Использование addTrack вместо getSenders для простоты
      peerConnection.addTrack(track, localStream);
    });
    console.log('Локальные дорожки добавлены в PeerConnection.');
  } else {
      // Это не должно произойти, так как getLocalMedia() вызывается до создания PC
      console.error('localStream не готов при создании PeerConnection!');
  }

  // ICE кандидаты
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && currentTarget) {
      console.log('Отправка ICE кандидата:', event.candidate);
      socket.emit('signal', { type: 'candidate', candidate: event.candidate, target: currentTarget });
    }
  };

  // Получение удаленных треков (ключевое изменение)
  peerConnection.ontrack = (event) => {
    // В большинстве современных браузеров, удаленные треки сгруппированы в event.streams[0]
    if (event.streams && event.streams[0]) {
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteStream = event.streams[0];
            remoteVideo.srcObject = remoteStream;
            console.log('Удаленный поток установлен в remoteVideo через event.streams[0].');
        }
    } else {
        // Резервная логика: добавляем трек к нашему потоку
        if (!remoteStream) {
          remoteStream = new MediaStream();
          remoteVideo.srcObject = remoteStream;
        }
        remoteStream.addTrack(event.track);
        console.log('Удаленный трек добавлен к remoteStream.');
    }
  };

  // DataChannel от принимающей стороны
  peerConnection.ondatachannel = (event) => {
    dataChannel = event.channel;
    setupDataChannel();
  };

  // Соединение закрыто
  peerConnection.onconnectionstatechange = () => {
    console.log('PC state:', peerConnection.connectionState);
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

// Обработка сигналов
socket.on('signal', async (data) => {
  const sender = data.sender;
  try {
    if (data.type === 'offer') {
      // Получатель:
      console.log('Получен OFFER от', sender);
      await getLocalMedia(); // 1. Получаем локальный поток
      createPeerConnection(sender); // 2. Создаем PC и добавляем в него локальный поток
      isInitiator = false;

      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', sdp: answer, target: sender });
      console.log('Отправлен ANSWER');

    } else if (data.type === 'answer') {
      // Инициатор:
      console.log('Получен ANSWER');
      if (!peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

    } else if (data.type === 'candidate') {
      console.log('Получен ICE кандидат');
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

  try {
    // Инициатор:
    await getLocalMedia(); // 1. Получаем локальный поток
    createPeerConnection(target); // 2. Создаем PC и добавляем в него локальный поток
    isInitiator = true;

    // DataChannel
    dataChannel = peerConnection.createDataChannel('chat');
    setupDataChannel();

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { type: 'offer', sdp: offer, target: target });
    logChat('Система: оффер отправлен');
  } catch (err) {
    console.error('startCall error', err);
    alert('Не удалось начать вызов: ' + (err.message || err));
  }
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

// --- Отладка устройств ---
async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('Devices:', devices);
  } catch (err) {
    console.warn('enumerateDevices error', err);
  }
}
listDevices();
