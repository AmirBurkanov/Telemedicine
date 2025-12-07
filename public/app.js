// ============================================================
//   ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ============================================================
let socket = io();
let peerConnection = null;

let localStream = null;
let remoteStream = null;

let currentTargetId = null;
let candidateBuffer = [];

const servers = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// ============================================================
//   1. Получаем камеру + микрофон сразу
// ============================================================
async function initLocalMedia() {
    if (localStream) return localStream;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        const localVideo = document.getElementById("localVideo");
        localVideo.srcObject = localStream;
        localVideo.muted = true;
        await localVideo.play();

        console.log("Local media initialized");
        return localStream;

    } catch (e) {
        console.error("Media error:", e);
        alert("Ошибка доступа к камере/микрофону");
    }
}

// ============================================================
//   2. Создание PeerConnection
// ============================================================
function createPeerConnection(targetId) {
    if (peerConnection) {
        console.warn("PeerConnection already exists");
        return peerConnection;
    }

    console.log("Creating PeerConnection with:", targetId);
    currentTargetId = targetId;

    peerConnection = new RTCPeerConnection(servers);

    // ---- создаём remote stream ----
    remoteStream = new MediaStream();
    const remoteVideo = document.getElementById("remoteVideo");

    remoteVideo.srcObject = remoteStream;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;
    remoteVideo.muted = false;
    remoteVideo.volume = 1;

    remoteVideo.onloadedmetadata = () => {
        remoteVideo.play().catch(err => console.warn("Autoplay block:", err));
    };

    // ---- добавляем локальные дорожки ----
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    // ---- получаем треки от удалённого ----
    peerConnection.ontrack = (event) => {
        console.log("ONTRACK:", event.track.kind);

        const track = event.track;
        const already = remoteStream.getTracks().some(t => t.id === track.id);
        if (!already) remoteStream.addTrack(track);

        remoteVideo.play().catch(() => {});
    };

    // ---- ICE кандидаты ----
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("signal", {
                target: currentTargetId,
                data: { candidate: event.candidate }
            });
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log("PC state:", peerConnection.iceConnectionState);
    };

    return peerConnection;
}

// ============================================================
//   3. Инициатор начинает звонок
// ============================================================
document.getElementById("callBtn").onclick = async () => {
    const targetInput = document.getElementById("targetId").value.trim();
    if (!targetInput) {
        alert("Введите ID собеседника!");
        return;
    }

    const targetId = targetInput.replace("ID: ", "");

    await initLocalMedia();

    createPeerConnection(targetId);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit("signal", {
        target: targetId,
        data: offer
    });

    console.log("Offer sent");
};

// ============================================================
//   4. Сигналы от сервера
// ============================================================
socket.on("signal", async ({ from, data }) => {
    console.log("Signal received", data);

    // создаём PC если нет
    if (!peerConnection) {
        await initLocalMedia();
        createPeerConnection(from);
    }

    // ===== OFFER =====
    if (data.type === "offer") {
        console.log("Received OFFER");

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socket.emit("signal", {
            target: from,
            data: answer
        });

        console.log("ANSWER sent");
    }

    // ===== ANSWER =====
    else if (data.type === "answer") {
        console.log("Received ANSWER");

        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));

        // применяем буфер
        for (let cand of candidateBuffer) {
            await peerConnection.addIceCandidate(cand);
        }
        candidateBuffer = [];
    }

    // ===== ICE-кандидат =====
    else if (data.candidate) {
        const cand = new RTCIceCandidate(data.candidate);

        if (peerConnection.remoteDescription) {
            peerConnection.addIceCandidate(cand);
            console.log("addIceCandidate success");
        } else {
            console.log("Buffered candidate");
            candidateBuffer.push(cand);
        }
    }
});

// ============================================================
//  5. ВЫКЛЮЧЕНИЕ / ВКЛЮЧЕНИЕ МИКРОФОНА
// ============================================================
document.getElementById("micBtn").onclick = () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;

    document.getElementById("micBtn").textContent =
        audioTrack.enabled ? "Mute Mic" : "Unmute Mic";
};

// ============================================================
//  6. ВЫКЛЮЧЕНИЕ / ВКЛЮЧЕНИЕ КАМЕРЫ
// ============================================================
document.getElementById("camBtn").onclick = () => {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (!videoTrack) return;

    videoTrack.enabled = !videoTrack.enabled;

    document.getElementById("camBtn").textContent =
        videoTrack.enabled ? "Turn Off Camera" : "Turn On Camera";
};

// ============================================================
//  7. КОНЕЦ — все работает 💯
// ============================================================
