// public/app.js
// ⚠️ Замените URL на ваш домен Render
const socket = io('https://telemedicine-1-56qy.onrender.com/'); 

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
  const d = document.createElement('div');
  d.textContent = text;
  chatLog.appendChild(d);
  chatLog.scrollTop = chatLog.scrollHeight;
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
async function createPeerConnection(targetId){
  currentTarget = targetId;
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Добавляем локальные треки
  if (!localStream) await getLocalMedia();
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  // ICE кандидаты
  peerConnection.onicecandidate = (e) => {
    if (e.candidate && currentTarget) {
      socket.emit('signal', { type: 'candidate', candidate: e.candidate, target: currentTarget });
      console.log('ICE candidate sent', e.candidate);
    }
  };

  // Удалённые треки
  peerConnection.ontrack = (e) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(e.track); // добавляем трек напрямую
  };


  // DataChannel
  peerConnection.ondatachannel = (evt) => {
    dataChannel = evt.channel;
    setupDataChannel();
  };

  peerConnection.onconnectionstatechange = () => {
  console.log('PC state:', peerConnection.connectionState);
  if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
    cleanupCall();
  }
};


function setupDataChannel(){
  if (!dataChannel) return;
  dataChannel.onopen = () => logChat('Система: dataChannel открыт');
  dataChannel.onmessage = (e) => logChat('Собеседник: ' + e.data);
  dataChannel.onclose = () => logChat('Система: dataChannel закрыт');
}

// --- Cleanup ---
function cleanupCall(){
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

// --- Signaling ---
socket.on('connect', () => setStatus('online'));
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

socket.on('signal', async (data) => {
  try {
    const sender = data.sender;
    if (data.type === 'offer') {
      await createPeerConnection(sender);
      isInitiator = false;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', sdp: answer, target: sender });
    } else if (data.type === 'answer') {
      if (peerConnection) await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'candidate') {
      if (peerConnection) await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (err) {
    console.error('Ошибка обработки signal', err);
  }
});

socket.on('chat', ({ sender, message }) => {
  logChat('Другой: ' + message);
});

// --- UI ---
startCallBtn.addEventListener('click', async () => {
  const target = userSelect.value;
  if (!target) return alert('Выберите пользователя для звонка');
  try {
    await getLocalMedia();
    await createPeerConnection(target);
    isInitiator = true;
    dataChannel = peerConnection.createDataChannel('chat');
    setupDataChannel();

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { type: 'offer', sdp: offer, target });
    logChat('Система: оффер отправлен');
  } catch (err) {
    console.error('startCall error', err);
    alert('Не удалось начать вызов: ' + (err.message || err));
  }
});

endCallBtn.addEventListener('click', cleanupCall);

toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const track = localStream.getAudioTracks()[0];
  if (track) { track.enabled = !track.enabled; }
});

toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const track = localStream.getVideoTracks()[0];
  if (track) { track.enabled = !track.enabled; }
});

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
