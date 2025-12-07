// public/app.js — исправленный, совместимый с твоим index.html + styles.css

const socket = io(); // подключается к текущему хосту автоматически

// UI элементы (совпадают с твоим HTML)
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

// Буфер кандидатов для каждого peer (ключ — peerId)
const pendingCandidates = {}; // { peerId: [RTCIceCandidateInit, ...] }

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// -------------------- helpers --------------------
function setStatus(text){ connStatus.textContent = text; }

function logChat(text){
  const d = document.createElement('div');
  d.textContent = text;
  chatLog.appendChild(d);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function ensurePending(peerId){
  if (!pendingCandidates[peerId]) pendingCandidates[peerId] = [];
}

// -------------------- getLocalMedia --------------------
async function getLocalMedia(){
  if (localStream) return localStream;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream = s;
    localVideo.srcObject = s;
    localVideo.muted = true; // локальный превью обычно muted
    try { await localVideo.play(); } catch(e){ /* ignore autoplay block on preview */ }
    // обновление текстов кнопок
    toggleMicBtn.textContent = localStream.getAudioTracks()[0]?.enabled ? 'Выкл/Вкл микрофон' : 'Вкл/Выкл микрофон';
    toggleCamBtn.textContent = localStream.getVideoTracks()[0]?.enabled ? 'Выкл/Вкл камеру' : 'Вкл/Выкл камеру';
    return s;
  } catch (err) {
    console.error('getUserMedia error', err);
    alert('Ошибка доступа к камере/микрофону: ' + (err.message || err));
    throw err;
  }
}

// -------------------- createPeerConnection --------------------
function createPeerConnection(peerId) {
  // если соединение уже есть и целевой другой — закрываем старое
  if (peerConnection && currentTarget && currentTarget !== peerId) {
    cleanupCall();
  }

  currentTarget = peerId;

  if (!peerConnection) {
    peerConnection = new RTCPeerConnection(rtcConfig);

    // заранее подготовим remoteStream и video элемент
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;

      // делаем попытку проиграть и включить звук (autoplay policy)
      remoteVideo.muted = false;
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      remoteVideo.volume = 1;
      remoteVideo.onloadedmetadata = () => {
        remoteVideo.play().catch(err => console.warn('remoteVideo.play blocked:', err));
      };
    }

    // если локальный поток уже есть — добавляем треки
    if (localStream) {
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }

    peerConnection.onicecandidate = (e) => {
      if (e.candidate && currentTarget) {
        socket.emit('signal', { type: 'candidate', candidate: e.candidate, target: currentTarget });
      }
    };

    peerConnection.ontrack = (e) => {
      console.log('ontrack', e.track.kind, e.track.id);
      // добавляем трек в remoteStream если ещё нет
      if (!remoteStream.getTracks().some(t => t.id === e.track.id)) {
        remoteStream.addTrack(e.track);
      }
      // попытка проиграть
      remoteVideo.play().catch(() => {});
    };

    peerConnection.ondatachannel = (evt) => {
      dataChannel = evt.channel;
      setupDataChannel();
    };

    peerConnection.onconnectionstatechange = () => {
      console.log('PC state:', peerConnection.connectionState);
      if (['disconnected','failed','closed'].includes(peerConnection.connectionState)) {
        logChat('Система: соединение потеряно');
        // не всегда хотим полностью очищать UI сразу; но в большинстве случаев cleanup полезен
      }
    };
  }
  return peerConnection;
}

function setupDataChannel(){
  if (!dataChannel) return;
  dataChannel.onopen = () => { logChat('Система: dataChannel открыт'); };
  dataChannel.onmessage = (e) => { logChat('Собеседник: ' + e.data); };
  dataChannel.onclose = () => { logChat('Система: dataChannel закрыт'); };
  dataChannel.onerror = (err) => console.warn('DataChannel error', err);
}

// -------------------- apply pending candidates --------------------
async function applyPendingCandidates(peerId){
  const queue = pendingCandidates[peerId];
  if (!queue || !peerConnection) return;
  while (queue.length) {
    const cand = queue.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      console.log('Применён отложенный кандидат для', peerId);
    } catch (err) {
      console.warn('Ошибка addIceCandidate (отложенный):', err);
    }
  }
}

// -------------------- signaling handlers --------------------
socket.on('connect', () => {
  setStatus('online');
  console.log('socket connected', socket.id);
});

socket.on('disconnect', () => {
  setStatus('offline');
});

// поддерживаем оба имени события списка пользователей (userList или users)
socket.on('userList', (list) => populateUsers(list));
socket.on('users', (list) => populateUsers(list));

function populateUsers(list){
  // list может быть массивом socket.id
  userSelect.innerHTML = '<option value="">-- Выберите пользователя --</option>';
  list.forEach(id => {
    if (id === socket.id) return;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    userSelect.appendChild(opt);
  });
}

// Унифицированный handler для 'signal' — сервер может посылать в разном формате.
// Возможные форматы, которые мы поддерживаем:
// 1) old: io.to(target).emit('signal', { ...data, sender: socket.id })
// 2) new: io.to(target).emit('signal', { from: senderId, data: { type:'offer' | 'answer' | 'candidate', ... } })
socket.on('signal', async (msg) => {
  try {
    console.log('Signal received raw:', msg);

    // нормализуем payload => { sender, payload }
    let sender = null;
    let payload = null;

    if (msg && msg.sender) {
      // формат: { type, sdp?, candidate?, sender }
      sender = msg.sender;
      payload = { type: msg.type, sdp: msg.sdp, candidate: msg.candidate };
    } else if (msg && msg.from && msg.data) {
      sender = msg.from;
      payload = msg.data;
    } else {
      // возможно сервер послал { from, type, sdp, candidate }
      if (msg && msg.from) {
        sender = msg.from;
        payload = Object.assign({}, msg);
        delete payload.from;
      } else {
        // неизвестный формат — показать в консоль и выйти
        console.warn('Unknown signal message format', msg);
        return;
      }
    }

    // Ensure pending queue exists
    ensurePending(sender);

    // Если пришёл offer
    if (payload.type === 'offer') {
      console.log('Received OFFER from', sender);

      await getLocalMedia().catch(()=>{}); // попытаться и не падать

      createPeerConnection(sender);
      isInitiator = false;

      // защитимся: если локальные треки появились позже — добавим отсутствующие
      if (localStream) {
        const existingSenderTrackIds = peerConnection.getSenders().map(s => s.track && s.track.id).filter(Boolean);
        localStream.getTracks().forEach(track => {
          if (!existingSenderTrackIds.includes(track.id)) peerConnection.addTrack(track, localStream);
        });
      }

      // setRemoteDescription (используем payload.sdp или payload)
      const sdp = payload.sdp || payload;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));

      // применить отложенные кандидаты
      await applyPendingCandidates(sender);

      // создать и отправить answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', sdp: answer, target: sender });
      logChat('Система: отправлен answer');

      return;
    }

    // Если пришёл answer
    if (payload.type === 'answer') {
      console.log('Received ANSWER from', sender);
      if (!peerConnection) {
        console.warn('Нет peerConnection при получении answer — создаём.');
        createPeerConnection(sender);
      }
      const sdp = payload.sdp || payload;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      await applyPendingCandidates(sender);
      logChat('Система: получен answer');
      return;
    }

    // Если пришёл кандидат
    if (payload.candidate) {
      // Если нет peerConnection — буферизуем
      if (!peerConnection) {
        ensurePending(sender);
        pendingCandidates[sender].push(payload.candidate);
        console.log('Буферизован кандидат (нет peerConnection) для', sender);
        return;
      }
      // Если нет remoteDescription — буферизуем (надо remoteDescription чтобы добавлять кандидаты)
      if (!peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
        ensurePending(sender);
        pendingCandidates[sender].push(payload.candidate);
        console.log('Буферизован кандидат (нет remoteDescription) для', sender);
        return;
      }
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
        console.log('addIceCandidate success');
      } catch (err) {
        console.warn('addIceCandidate error', err);
      }
      return;
    }

    console.warn('Signal: unknown payload', payload);
  } catch (err) {
    console.error('Ошибка обработки signal', err);
  }
});

// резервный чат через сокеты
socket.on('chat', ({ sender, message }) => {
  logChat('Другой: ' + message);
});

// -------------------- UI Actions --------------------
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

    // убедимся, что локальные дорожки добавлены
    if (localStream) {
      const existingSenderTrackIds = peerConnection.getSenders().map(s => s.track && s.track.id).filter(Boolean);
      localStream.getTracks().forEach(track => {
        if (!existingSenderTrackIds.includes(track.id)) peerConnection.addTrack(track, localStream);
      });
    }

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
  // необязательное уведомление другой стороне
  if (currentTarget) socket.emit('signal', { type: 'hangup', target: currentTarget });
  cleanupCall();
});

toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const at = localStream.getAudioTracks()[0];
  if (at) {
    at.enabled = !at.enabled;
    toggleMicBtn.textContent = at.enabled ? 'Выкл/Вкл микрофон' : 'Вкл/Выкл микрофон';
    logChat('Система: микрофон ' + (at.enabled ? 'включён' : 'выключен'));
  }
});

toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const vt = localStream.getVideoTracks()[0];
  if (vt) {
    vt.enabled = !vt.enabled;
    toggleCamBtn.textContent = vt.enabled ? 'Выкл/Вкл камеру' : 'Вкл/Выкл камеру';
    logChat('Система: камера ' + (vt.enabled ? 'включена' : 'выключена'));
  }
});

// чат (DataChannel либо socket fallback)
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

// -------------------- cleanup --------------------
function cleanupCall(){
  if (peerConnection) {
    try { peerConnection.close(); } catch(e) { console.warn(e); }
  }
  peerConnection = null;
  dataChannel = null;
  remoteStream && remoteStream.getTracks().forEach(t => t.stop && t.stop());
  remoteStream = null;
  remoteVideo.srcObject = null;
  currentTarget = null;
  isInitiator = false;
  // очистка буфера для всех — можно оставить, но логично очистить
  Object.keys(pendingCandidates).forEach(k => pendingCandidates[k] = []);
  logChat('Система: звонок завершён');
}

// -------------------- небольшая отладка --------------------
async function listDevices(){
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('Devices:', devices);
  } catch (err) {
    console.warn('enumerateDevices error', err);
  }
}
listDevices();
