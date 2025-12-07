// public/app.js (исправленная версия)
// WebRTC + Socket.io — устойчивее к гонкам (offers / candidates) и кранчам с getUserMedia.

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

// Буфер кандидатов для каждого target (если кандидаты приходят до создания PC)
const pendingCandidates = {}; // { targetId: [candidateObj, ...] }

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- Helpers ---
function logChat(text){
  const d = document.createElement('div'); d.textContent = text;
  chatLog.appendChild(d); chatLog.scrollTop = chatLog.scrollHeight;
}

function setStatus(s){ connStatus.textContent = s; }

// Очистка состояния звонка
function closeCall() {
  if (peerConnection) {
    try { peerConnection.close(); } catch(e){ console.warn(e); }
  }
  peerConnection = null;
  dataChannel = null;
  currentTarget = null;
  isInitiator = false;
  if (remoteStream) {
    remoteStream.getTracks().forEach(t => t.stop && t.stop());
    remoteStream = null;
  }
  remoteVideo.srcObject = null;
  logChat('Система: звонок завершён');
}

// --- Media ---
async function getLocalMedia(){
  if (localStream) return localStream;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream = stream;
    localVideo.srcObject = stream;
    // Обновление кнопок по состоянию дорожек
    toggleMicBtn.textContent = localStream.getAudioTracks()[0]?.enabled ? 'Выкл/Вкл микрофон' : 'Вкл/Выкл микрофон';
    toggleCamBtn.textContent = localStream.getVideoTracks()[0]?.enabled ? 'Выкл/Вкл камеру' : 'Вкл/Выкл камеру';
    return stream;
  } catch (err) {
    console.error('getUserMedia error', err);
    alert('Ошибка доступа к камере/микрофону: ' + (err.message || err));
    throw err;
  }
}

// Инициализируем локальное медиа при старте (чтобы уменьшить шанс race condition)
getLocalMedia().catch(err => {
  // Если пользователь отклонил доступ — продолжим, но звонки не будут работать
  console.warn('Не получилось получить локальное медиа при старте:', err && err.message);
});

// --- PeerConnection ---
function createPeerConnection(targetId) {
  // Если уже есть соединение к другому target — закрываем его
  if (peerConnection && currentTarget && currentTarget !== targetId) {
    closeCall();
  }

  currentTarget = targetId;
  if (!peerConnection) {
    peerConnection = new RTCPeerConnection(rtcConfig);

    // Создаём/подключаем remoteStream заранее — это упрощает логику ontrack
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }

    // Добавляем локальные дорожки (если они уже получены)
    if (localStream) {
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });
    }

    // ICE кандидаты -> отправляем удалённой стороне
    peerConnection.onicecandidate = (e) => {
      if (e.candidate && currentTarget) {
        socket.emit('signal', { type: 'candidate', candidate: e.candidate, target: currentTarget });
      }
    };

    // Когда приходят треки — добавляем их в remoteStream
    peerConnection.ontrack = (e) => {
      console.log('ontrack', e.track.kind, e.track);
      // некоторые браузеры шлют один и тот же трек несколько раз — guard
      const already = remoteStream.getTracks().some(t => t.id === e.track.id);
      if (!already) remoteStream.addTrack(e.track);
    };

    // Если мы не инициатор — сюда может прийти datachannel
    peerConnection.ondatachannel = (evt) => {
      console.log('ondatachannel', evt.channel.label);
      dataChannel = evt.channel;
      setupDataChannel();
    };

    peerConnection.onconnectionstatechange = () => {
      console.log('PC state:', peerConnection.connectionState);
      if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
        // не сразу закрываем UI — но выполняем локальную очистку
        // при необходимости можно показывать уведомление
      }
    };
  }

  // Если в очереди есть кандидаты для этого target — попробуем применить их
  if (pendingCandidates[targetId] && pendingCandidates[targetId].length > 0) {
    // Попытка применить — но кандидаты могут потребовать remoteDescription -> обработается позже в handlePendingCandidates
    // Просто оставляем очередь: handlePendingCandidates вызовется после setRemoteDescription
  }

  return peerConnection;
}

// После установки remoteDescription пытаемся применить накопленные кандидаты
async function handlePendingCandidates(targetId) {
  const queue = pendingCandidates[targetId];
  if (!queue || !peerConnection) return;
  while (queue.length) {
    const cand = queue.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      console.log('Применён отложенный кандидат для', targetId);
    } catch (err) {
      console.warn('Ошибка addIceCandidate (отложенный):', err);
    }
  }
}

function setupDataChannel(){
  if (!dataChannel) return;
  dataChannel.onopen = () => { logChat('Система: dataChannel открыт'); };
  dataChannel.onmessage = (e) => { logChat('Собеседник: ' + e.data); };
  dataChannel.onclose = () => { logChat('Система: dataChannel закрыт'); };
  dataChannel.onerror = (err) => { console.warn('DataChannel error', err); };
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
    if (!sender) return;

    if (data.type === 'offer') {
      // Принимаем входящий offer
      await getLocalMedia().catch(()=>{}); // попытаться, но не ломать, если отказан
      createPeerConnection(sender);
      isInitiator = false;

      // ВАЖНО: если локальные дорожки были получены после создания соединения — нужно убедиться, что они добавлены
      if (localStream) {
        // Добавить отсутствующие треки (защита от двойного добавления)
        const senders = peerConnection.getSenders().map(s => s.track && s.track.id);
        localStream.getTracks().forEach(track => {
          if (!senders.includes(track.id)) peerConnection.addTrack(track, localStream);
        });
      }

      // Установим remoteDescription из offer
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      // Теперь можно применить любые отложенные кандидаты
      await handlePendingCandidates(sender);

      // Создаём answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', sdp: answer, target: sender });
      logChat('Система: отправлен answer');
    } else if (data.type === 'answer') {
      // Получили answer на наш offer (инициатор)
      if (!peerConnection) {
        console.warn('Нет peerConnection при получении answer — создаём.');
        createPeerConnection(sender);
      }
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      // После установки remoteDescription применяем отложенные кандидаты
      await handlePendingCandidates(sender);
      logChat('Система: получен answer');
    } else if (data.type === 'candidate') {
      // ICE кандидат
      if (!peerConnection) {
        // Буферизуем кандидата до создания peerConnection
        pendingCandidates[sender] = pendingCandidates[sender] || [];
        pendingCandidates[sender].push(data.candidate);
        console.log('Буферизован кандидат для', sender);
        return;
      }
      // Если remoteDescription ещё не выставлен — также буферизуем, т.к. addIceCandidate может проигнорироваться
      if (!peerConnection.remoteDescription || peerConnection.remoteDescription.type === null) {
        pendingCandidates[sender] = pendingCandidates[sender] || [];
        pendingCandidates[sender].push(data.candidate);
        console.log('Буферизован кандидат (нет remoteDescription) для', sender);
        return;
      }
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        console.log('addIceCandidate success');
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

    // убедимся, что локальные дорожки добавлены
    if (localStream) {
      const senders = peerConnection.getSenders().map(s => s.track && s.track.id);
      localStream.getTracks().forEach(track => {
        if (!senders.includes(track.id)) peerConnection.addTrack(track, localStream);
      });
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { type: 'offer', sdp: offer, target: target });
    logChat('Система: оффер отправлен');
  } catch (err) {
    console.error('startCall error', err);
    alert('Не удалось начать вызов: ' + (err.message || err));
    closeCall();
  }
});

endCallBtn.addEventListener('click', () => {
  socket.emit('signal', { type: 'hangup', target: currentTarget }); // необязательно, сервер может не обрабатывать
  closeCall();
});

toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const at = localStream.getAudioTracks()[0];
  if (at) {
    at.enabled = !at.enabled;
    toggleMicBtn.textContent = at.enabled ? 'Выкл/Вкл микрофон' : 'Вкл/Выкл микрофон';
  }
});

toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return alert('Локальный поток не инициализирован');
  const vt = localStream.getVideoTracks()[0];
  if (vt) {
    vt.enabled = !vt.enabled;
    toggleCamBtn.textContent = vt.enabled ? 'Выкл/Вкл камеру' : 'Вкл/Выкл камеру';
  }
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

// --- Утилиты для отладки ---
async function listDevices(){
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('Devices:', devices);
  } catch (err) {
    console.warn('enumerateDevices error', err);
  }
}
listDevices();
