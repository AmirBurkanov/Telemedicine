// ==========================================
// app.js — стабильный WebRTC + Socket.IO
// ==========================================

const socket = io();

// ---------- UI ----------
const myIdElem = document.getElementById("myId");
const userListElem = document.getElementById("users");
const targetIdInput = document.getElementById("targetId");
const callBtn = document.getElementById("callBtn");
const micBtn = document.getElementById("micBtn");
const camBtn = document.getElementById("camBtn");

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

// ---------- RTC ----------
let pc = null;
let localStream = null;
let remoteStream = null;
let candidateBuffer = [];
let callTarget = null;

// ---------- RTC CONFIG ----------
const rtcConfig = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// ==========================================
// Utility: create PC
// ==========================================
function createPeerConnection() {
    pc = new RTCPeerConnection(rtcConfig);

    // локальные дорожки
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    // ICE кандидаты
    pc.onicecandidate = (event) => {
        if (event.candidate && callTarget) {
            socket.emit("signal", {
                target: callTarget,
                data: { candidate: event.candidate }
            });
        }
    };

    // получаем дорожки
    pc.ontrack = (event) => {
        if (!remoteStream) {
            remoteStream = new MediaStream();
            remoteVideo.srcObject = remoteStream;

            remoteVideo.muted = false;
            remoteVideo.volume = 1;

            remoteVideo.onloadedmetadata = () => {
                remoteVideo.play().catch(err =>
                    console.warn("Remote video autoplay blocked:", err)
                );
            };
        }
        remoteStream.addTrack(event.track);
    };

    // состояние PC
    pc.onconnectionstatechange = () => {
        console.log("PC state:", pc.connectionState);
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
            endCall();
        }
    };

    return pc;
}

// ==========================================
// Get camera + mic
// ==========================================
async function getLocalMedia() {
    if (localStream) return localStream;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
        });

        localVideo.srcObject = localStream;
        return localStream;

    } catch (err) {
        console.error("getUserMedia error:", err);
        alert("Ошибка доступа к микрофону/камере: " + err.message);
        throw err;
    }
}

// ==========================================
// Socket events
// ==========================================
socket.on("connect", () => {
    myIdElem.textContent = socket.id;
});

// список пользователей
socket.on("userList", (list) => {
    userListElem.innerHTML = "";
    list.forEach(id => {
        const li = document.createElement("li");
        li.textContent = id;

        li.onclick = () => {
            targetIdInput.value = id;
        };

        userListElem.appendChild(li);
    });
});

// сигналы WebRTC
socket.on("signal", async ({ from, data }) => {
    try {
        console.log("Signal:", data);

        if (!pc) {
            console.log("Creating PC due to incoming signal");
            createPeerConnection();
        }

        // ----- OFFER -----
        if (data.type === "offer") {
            callTarget = from;

            await getLocalMedia();

            if (!pc) createPeerConnection();

            await pc.setRemoteDescription(new RTCSessionDescription(data));

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            socket.emit("signal", {
                target: from,
                data: pc.localDescription
            });

            // применяем отложенные ICE
            flushBufferedCandidates();
        }

        // ----- ANSWER -----
        else if (data.type === "answer") {
            await pc.setRemoteDescription(new RTCSessionDescription(data));

            flushBufferedCandidates();
        }

        // ----- ICE Candidate -----
        else if (data.candidate) {
            const candidate = new RTCIceCandidate(data.candidate);

            if (pc.remoteDescription) {
                await pc.addIceCandidate(candidate);
                console.log("ICE applied");
            } else {
                console.log("ICE buffered");
                candidateBuffer.push(candidate);
            }
        }

    } catch (err) {
        console.error("Signal error:", err);
    }
});

// применить отложенные ICE-кандидаты
async function flushBufferedCandidates() {
    if (!candidateBuffer.length) return;
    for (const c of candidateBuffer) {
        try {
            await pc.addIceCandidate(c);
        } catch (err) {
            console.warn("Error applying buffered ICE:", err);
        }
    }
    console.log("Buffered ICE applied");
    candidateBuffer = [];
}

// ==========================================
// Start call
// ==========================================
callBtn.onclick = async () => {
    const target = targetIdInput.value.trim();
    if (!target) return alert("Select target ID first");

    callTarget = target;

    await getLocalMedia();
    createPeerConnection();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit("signal", {
        target: target,
        data: offer
    });

    console.log("Offer sent");
};

// ==========================================
// End call
// ==========================================
function endCall() {
    if (pc) {
        pc.close();
