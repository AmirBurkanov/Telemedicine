const socket = io();

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const startCallBtn = document.getElementById('startCall');
const endCallBtn = document.getElementById('endCall');
const toggleMicBtn = document.getElementById('toggleMic');
const toggleCamBtn = document.getElementById('toggleCam');
const userSelect = document.getElementById('userSelect');

let localStream;
let remoteStream;
let peerConnection;
let currentTarget;

const configuration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Получение локального видео/аудио
async function getLocalMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
    } catch (err) {
        alert('Ошибка доступа к камере/микрофону: ' + err);
    }
}

// Создание PeerConnection
function createPeerConnection(targetId) {
    currentTarget = targetId;
    peerConnection = new RTCPeerConnection(configuration);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
        if (!remoteStream) {
            remoteStream = new MediaStream();
            remoteVideo.srcObject = remoteStream;
        }
        remoteStream.addTrack(event.track);
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate && currentTarget) {
            socket.emit('candidate', { candidate: event.candidate, target: currentTarget });
        }
    };
}

// Начало вызова
async function startCall() {
    const targetId = userSelect.value;
    if (!targetId) return alert("Выберите пользователя для звонка");

    await getLocalMedia();
    createPeerConnection(targetId);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', { sdp: offer, target: targetId });
}

// Завершение звонка
function endCall() {
    if (peerConnection) peerConnection.close();
    peerConnection = null;
    remoteVideo.srcObject = null;
}

// Переключение микрофона
function toggleMic() {
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
}

// Переключение камеры
function toggleCam() {
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
}

// Socket.IO события
socket.on('users', (users) => {
    userSelect.innerHTML = '<option value="">Выберите пользователя</option>';
    users.forEach(u => {
        if (u !== socket.id) {
            const option = document.createElement('option');
            option.value = u;
            option.textContent = u;
            userSelect.appendChild(option);
        }
    });
});

socket.on('offer', async (data) => {
    createPeerConnection(data.sender);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', { sdp: answer, target: data.sender });
});

socket.on('answer', async (data) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
});

socket.on('candidate', async (data) => {
    if (peerConnection) await peerConnection.addIceCandidate(data.candidate || data);
});

startCallBtn.onclick = startCall;
endCallBtn.onclick = endCall;
toggleMicBtn.onclick = toggleMic;
toggleCamBtn.onclick = toggleCam;
