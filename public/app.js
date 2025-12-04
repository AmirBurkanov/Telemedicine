// public/app.js
// Полная рабочая логика: getUserMedia, RTCPeerConnection, signal via Socket.io,
// DataChannel chat + fallback через сокеты, UI handlers.

const socket = io(); // подключается к текущему хосту автоматически

// UI
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

let localStream = null;
let peerConnection = null;
let dataChannel = null;
let remoteStream = null;
let currentTarget = null;
let isInitiator = false;

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- Helpers ---
function logChat(text){
  const d = document.createElement('div'); d.textContent = text;
  chatLog.appendChild(d); chatLog.scrollTop = chatLog.scrollHeight;
}

function setStatus(s){ connStatus.textContent = s; }

// --- Media ---
async function getLocalMedia(){
  if (localStream) return localStream;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream = stream;
    localVideo.srcObject = stream;
    return stream;
  } catch (err) {
    console.error('getUserMedia error', err);
    alert('Ошибка доступа к камере/микрофону: ' + (err.message || err));
    throw err;
  }
}

// --- PeerConnection ---
function createPeerConnection(targetId){
  currentTarget = targetId;
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Добавить локальные дорожки (если есть)
  if (localStream) {
    for (const t of localStream.getTracks()) peerConnection.addTrack(t, localStream);
  }

  // собрать ICE кандидаты
  peerConnection.onicecandidate = (e) => {
    if (e.candidate && currentTarget) {
      socket.emit('signal', { type: 'candidate', candidate: e.candidate, target: currentTarget });
    }
  };

  // при получении треков
  peerConnection.ontrack = (e) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(e.track);
  };

  // если это не инициатор, может прийти datachannel
  peerConnection.ondatachannel = (evt) => {
    dataChannel = evt.channel;
    setupDataChannel();
  };

  // debug
  peerConnection.onconnectionstatechange = () => {
    console.log('PC state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
      // cleanup
    }
  };
}

function setupDataChannel(){
  if (!dataChannel) return;
  dataChannel.onopen = () => { logChat('Система: dataChannel открыт'); };
  dataChannel.onmessage = (e) => { logChat('Собеседник: ' + e.data); };
  dataChannel.onclose = () => { logChat('Система: dataChannel закрыт'); };
}

// --- Signaling handlers ---
socket.on('connect', () => {
  setStatus('online');
  console.log('connected, id=', socket.id);
});

socket.on('disconnect', () => {
  setStatus('offline');
});

// Сервер присылает список пользователей (массив socket.id)
socket.on('users', (users) => {
  // очистка, добавление опций
  userSelect.innerHTML = '<option value="">-- Выберите пользователя --</option>';
  users.forEach(id => {
    if (id === socket.id) return;
    const opt = document.createElement('option'); opt.value = id; opt.textContent = id;
    userSelect.appendChild(opt);
  });
});

// Сервер форвардит 'signal' от других клиентов
socket.on('signal', async (data) => {
  // data: { type, sdp?, candidate?, sender }
  try {
    console.log('Signal received', data);
    const sender = data.sender;
    if (data.type === 'offer') {
      // получить локальный stream, создать PC если нужно
      await getLocalMedia();
      createPeerConnection(sender);
      isInitiator = false;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', sdp: answer, target: sender });
    } else if (data.type === 'answer') {
      if (!peerConnection) {
        console.warn('Нет peerConnection при получении answer');
        return;
      }
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'candidate') {
      if (!peerConnection) {
        console.warn('Нет peerConnection при получении candidate, создаём временный pc?');
        return;
      }
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.warn('addIceCandidate error', err);
      }
    }
  } catch (err) {
    console.error('Ошибка обработки signal', err);
  }
});

// Резервный чат (если dataChannel не доступен)
socket.on('chat', ({ sender, message }) => {
  logChat('Другой: ' + message);
});

// --- UI actions ---
startCallBtn.addEventListener('click', async () => {
  const target = userSelect.value;
  if (!target) return alert('Выберите пользователя для звонка');
  try {
    await getLocalMedia();
    createPeerConnection(target);
    isInitiator = true;
    // инициатор создаёт dataChannel
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

endCallBtn.addEventListener('click', () => {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
    dataChannel = null;
    remoteStream = null;
    remoteVideo.srcObject = null;
    logChat('Система: звонок завершён');
  }
});

toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const at = localStream.getAudioTracks()[0];
  if (at) { at.enabled = !at.enabled; toggleMicBtn.textContent = at.enabled ? 'Выкл/Вкл микрофон' : 'Вкл/Выкл микрофон'; }
});

toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const vt = localStream.getVideoTracks()[0];
  if (vt) { vt.enabled = !vt.enabled; toggleCamBtn.textContent = vt.enabled ? 'Выкл/Вкл камеру' : 'Вкл/Выкл камеру'; }
});

// Чат (DataChannel или socket fallback)
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

// --- Небольшой тест — показать устройства в консоли (полезно для отладки) ---
async function listDevices(){
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('Devices:', devices);
  } catch (err) {
    console.warn('enumerateDevices error', err);
  }
}
listDevices();
