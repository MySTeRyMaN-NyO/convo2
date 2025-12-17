import {
  auth,
  db,
  setPersistence,
  inMemoryPersistence,
  signInAnonymously,
  onAuthStateChanged,
  ref,
  set,
  update,
  onValue,
  onDisconnect,
  remove,
  serverTimestamp
} from "./firebase.js";

let socket;
let nickname = "";
let roomId = "";
let localStream = null;
let peerConnection = null;
let remoteStream = null;
let pendingOffer = null;
let pendingIce = [];
let dmPendingIce = [];
let callActive = false;
let remoteStreamAttached = false;
let callConnected = false;
let rtcState = "idle";
let callScope = null;
let dmOutgoingTo = "";
let dmIncomingFrom = "";
let dmCallPeer = "";
let userList = [];
let screenSharing = false;
let screenStream = null;
let screenTrack = null;
let cameraTrack = null;
let groupCallActive = false;
let groupCallPending = false;
let groupCallCount = 0;
const GROUP_MAX = 4;
const groupPeerConnections = new Map();
const groupRemoteStreams = new Map();
let firebaseUid = "";
let firebaseReady = false;
let currentFirebaseRoom = "";
let firebaseUserListenerAttached = false;

const wsStatus = document.getElementById("wsStatus");
const messages = document.getElementById("messages");
const runDemo = document.getElementById("runDemo");
const joinPanel = document.getElementById("joinPanel");
const chatPanel = document.getElementById("chatPanel");
const mediaPanel = document.getElementById("mediaPanel");
const dmPanel = document.getElementById("dmPanel");
const joinBtn = document.getElementById("joinBtn");
const firebaseStatus = document.getElementById("firebaseStatus");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const callStatus = document.getElementById("callStatus");
const enableMediaBtn = document.getElementById("enableMediaBtn");
const toggleCameraBtn = document.getElementById("toggleCameraBtn");
const toggleMicBtn = document.getElementById("toggleMicBtn");
const startCallBtn = document.getElementById("startCallBtn");
const acceptCallBtn = document.getElementById("acceptCallBtn");
const hangUpBtn = document.getElementById("hangUpBtn");
const shareScreenBtn = document.getElementById("shareScreenBtn");
const shareScreenLabel = document.getElementById("shareScreenLabel");
const groupCountLabel = document.getElementById("groupCountLabel");
const joinGroupCallBtn = document.getElementById("joinGroupCallBtn");
const leaveGroupCallBtn = document.getElementById("leaveGroupCallBtn");
const groupVideos = document.getElementById("groupVideos");
const userListEl = document.getElementById("userList");
const dmStatusText = document.getElementById("dmStatusText");
const dmStatusDetail = document.getElementById("dmStatusDetail");
const dmIncoming = document.getElementById("dmIncoming");
const dmIncomingName = document.getElementById("dmIncomingName");
const dmAcceptBtn = document.getElementById("dmAcceptBtn");
const dmRejectBtn = document.getElementById("dmRejectBtn");

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

function addMessage(text) {
  const div = document.createElement("div");
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function setFirebaseStatus(text) {
  if (firebaseStatus) {
    firebaseStatus.textContent = text;
  }
}

function attachFirebaseUserListener() {
  if (firebaseUserListenerAttached) return;
  firebaseUserListenerAttached = true;
  const usersRef = ref(db, "users");
  onValue(usersRef, (snapshot) => {
    const users = snapshot.val() || {};
    const names = Object.values(users)
      .filter((user) => user && user.online && user.nickname)
      .map((user) => user.nickname);
    userList = names;
    renderUserList();
  }, (err) => {
    console.error("[FB] user list error", err);
  });
}

function initFirebase() {
  setFirebaseStatus("Connecting to Firebase...");
  onAuthStateChanged(auth, (user) => {
    if (user) {
      firebaseUid = user.uid;
      firebaseReady = true;
      setFirebaseStatus("Online");
      if (joinBtn) joinBtn.disabled = false;
      attachFirebaseUserListener();
    } else {
      firebaseUid = "";
      firebaseReady = false;
      if (joinBtn) joinBtn.disabled = true;
      setFirebaseStatus("Firebase offline");
    }
  });

  setPersistence(auth, inMemoryPersistence)
    .then(() => signInAnonymously(auth))
    .catch((err) => {
      console.error("[FB] auth error", err);
      firebaseUid = "";
      firebaseReady = false;
      if (joinBtn) joinBtn.disabled = true;
      setFirebaseStatus("Firebase offline");
    });
}

async function joinFirebaseRoom(name, room) {
  if (!firebaseReady || !firebaseUid) return;
  const userRef = ref(db, `users/${firebaseUid}`);
  const roomRef = ref(db, `rooms/${room}`);
  const memberRef = ref(db, `rooms/${room}/members/${firebaseUid}`);

  try {
    if (currentFirebaseRoom && currentFirebaseRoom !== room) {
      await remove(ref(db, `rooms/${currentFirebaseRoom}/members/${firebaseUid}`));
    }

    currentFirebaseRoom = room;
    await update(userRef, {
      nickname: name,
      online: true,
      lastSeen: serverTimestamp(),
      roomId: room
    });
    await update(roomRef, { name: room });
    await set(memberRef, true);

    onDisconnect(userRef).update({
      online: false,
      lastSeen: serverTimestamp(),
      roomId: ""
    });
    onDisconnect(memberRef).remove();
  } catch (err) {
    console.error("[FB] join room error", err);
  }
}

function setRtcState(state) {
  if (rtcState === state) return;
  rtcState = state;
  console.log(`[RTC] state: ${state}`);
  if (callStatus) {
    callStatus.textContent = state;
    callStatus.className = `call-status status-${state}`;
  }
  updateCallControls();
}

function isBusyForCalls() {
  return callActive || !!pendingOffer || !!dmOutgoingTo || !!dmIncomingFrom || groupCallActive || groupCallPending;
}

function updateCallControls() {
  startCallBtn.disabled = callActive || !!pendingOffer || !!dmOutgoingTo || !!dmIncomingFrom || groupCallActive || groupCallPending;
  acceptCallBtn.disabled = callActive || !pendingOffer || !!dmOutgoingTo || !!dmIncomingFrom || groupCallActive || groupCallPending;
  hangUpBtn.disabled = !callActive;
  updateScreenShareUI();
  updateDmControls();
  updateGroupUI();
}

function updateScreenShareUI() {
  const dmActive = callActive && callScope === "dm";
  if (shareScreenBtn) {
    shareScreenBtn.style.display = dmActive ? "inline-flex" : "none";
    shareScreenBtn.textContent = screenSharing ? "Stop Sharing" : "Share Screen";
  }
  if (shareScreenLabel) {
    shareScreenLabel.style.display = screenSharing ? "block" : "none";
  }
  if (toggleCameraBtn) {
    toggleCameraBtn.disabled = !localStream || screenSharing;
  }
  if (!dmActive && screenSharing) {
    stopScreenShare();
  }
}

function updateGroupUI() {
  if (!groupCountLabel) return;
  groupCountLabel.textContent = `${groupCallCount} / ${GROUP_MAX} in call`;

  const busy = callActive || !!pendingOffer || !!dmOutgoingTo || !!dmIncomingFrom || groupCallPending;
  joinGroupCallBtn.disabled = busy || groupCallActive || groupCallCount >= GROUP_MAX;
  leaveGroupCallBtn.disabled = !groupCallActive;

  if (groupVideos) {
    groupVideos.style.display = groupCallActive ? "grid" : "none";
  }
  if (remoteVideo) {
    remoteVideo.style.display = groupCallActive ? "none" : "block";
  }
}

function setGroupCount(count) {
  groupCallCount = Number.isFinite(count) ? count : 0;
  updateGroupUI();
}

function safePeerId(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function addGroupVideo(peer) {
  if (!groupVideos) return null;
  const id = `group-video-${safePeerId(peer)}`;
  let video = document.getElementById(id);
  if (!video) {
    video = document.createElement("video");
    video.id = id;
    video.className = "group-video";
    video.autoplay = true;
    video.playsInline = true;
    groupVideos.appendChild(video);
  }
  return video;
}

function removeGroupVideo(peer) {
  const id = `group-video-${safePeerId(peer)}`;
  const video = document.getElementById(id);
  if (video && video.parentElement) {
    video.parentElement.removeChild(video);
  }
}

function updateDmControls() {
  const busy = isBusyForCalls();
  const buttons = userListEl ? Array.from(userListEl.querySelectorAll("button[data-nickname]")) : [];
  buttons.forEach((button) => {
    const target = button.getAttribute("data-nickname");
    button.disabled = busy || target === nickname;
  });
  if (dmAcceptBtn) dmAcceptBtn.disabled = callActive || !dmIncomingFrom || groupCallActive || groupCallPending;
  if (dmRejectBtn) dmRejectBtn.disabled = callActive || !dmIncomingFrom || groupCallActive || groupCallPending;
}

function setDmStatus(text, detail) {
  if (!dmStatusText) return;
  dmStatusText.textContent = text;
  dmStatusDetail.textContent = detail || "";
}

function setIncomingDm(from) {
  dmIncomingFrom = from;
  if (dmIncomingName) dmIncomingName.textContent = from;
  if (dmIncoming) dmIncoming.style.display = "flex";
  setDmStatus("ringing", `Incoming call from ${from}`);
  updateCallControls();
}

function clearIncomingDm() {
  dmIncomingFrom = "";
  if (dmIncoming) dmIncoming.style.display = "none";
  if (dmIncomingName) dmIncomingName.textContent = "";
  updateCallControls();
}

function renderUserList() {
  if (!userListEl) return;
  userListEl.innerHTML = "";
  userList.forEach((name) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = name;
    const button = document.createElement("button");
    button.textContent = "Call";
    button.setAttribute("data-nickname", name);
    button.disabled = isBusyForCalls() || name === nickname;
    button.onclick = () => {
      startDmCall(name);
    };
    li.appendChild(label);
    li.appendChild(button);
    userListEl.appendChild(li);
  });
}

function startDmCall(target) {
  if (!target || target === nickname) return;
  if (!localStream) {
    alert("Enable Camera & Mic first.");
    return;
  }
  if (isBusyForCalls()) {
    alert("You are already in a call.");
    return;
  }
  dmOutgoingTo = target;
  setDmStatus("calling", `Calling ${target}...`);
  addMessage(`[SYSTEM] Calling ${target}...`);
  updateCallControls();
  sendSignal({ type: "dm-call-request", to: target });
}

function sendSignal(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.log("[WS] Cannot send, socket not open");
    return;
  }
  socket.send(JSON.stringify(payload));
}

function createPeerConnection() {
  if (peerConnection) return;

  peerConnection = new RTCPeerConnection(rtcConfig);
  console.log("[RTC] peer connection created");

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      const iceType = callScope === "dm" ? "dm-ice" : "ice";
      sendSignal({ type: iceType, candidate: event.candidate, to: dmCallPeer || undefined });
    }
  };

  peerConnection.ontrack = (event) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
    }
    remoteStream.addTrack(event.track);
    if (!remoteStreamAttached) {
      remoteVideo.srcObject = remoteStream;
      remoteStreamAttached = true;
      console.log("[RTC] remote stream attached");
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    if (state === "connected") {
      setRtcState("connected");
      if (!callConnected) {
        if (callScope === "dm") {
          addMessage(`[SYSTEM] DM call accepted with ${dmCallPeer}`);
          setDmStatus("connected", `In call with ${dmCallPeer}`);
        } else {
          addMessage("[SYSTEM] Call accepted");
        }
        callConnected = true;
      }
    }
    if (state === "disconnected" || state === "failed" || state === "closed") {
      console.log("[RTC] peer disconnected");
      endCall(false);
    }
  };

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  const iceQueue = callScope === "dm" ? dmPendingIce : pendingIce;
  iceQueue.forEach((candidate) => {
    peerConnection.addIceCandidate(candidate).then(() => {
      console.log("[RTC] ICE candidate added");
    }).catch((err) => {
      console.error("[RTC] ICE add error", err);
    });
  });
  if (callScope === "dm") {
    dmPendingIce = [];
  } else {
    pendingIce = [];
  }
}

function getVideoSender() {
  if (!peerConnection) return null;
  return peerConnection.getSenders().find((sender) => sender.track && sender.track.kind === "video") || null;
}

function createGroupPeerConnection(peer) {
  if (groupPeerConnections.has(peer)) return groupPeerConnections.get(peer);

  const pc = new RTCPeerConnection(rtcConfig);
  groupPeerConnections.set(peer, pc);
  console.log(`[GROUP] peer added ${peer}`);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ type: "group-ice", to: peer, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    let stream = groupRemoteStreams.get(peer);
    if (!stream) {
      stream = new MediaStream();
      groupRemoteStreams.set(peer, stream);
      const video = addGroupVideo(peer);
      if (video) {
        video.srcObject = stream;
      }
    }
    stream.addTrack(event.track);
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "disconnected" || state === "failed" || state === "closed") {
      removeGroupPeer(peer);
    }
  };

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  return pc;
}

async function sendGroupOffer(peer) {
  const pc = createGroupPeerConnection(peer);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: "group-offer", to: peer, sdp: offer.sdp });
    console.log("[RTC] group offer");
  } catch (err) {
    console.error("[RTC] group offer error", err);
  }
}

async function handleGroupOffer(from, sdp) {
  if (!localStream) return;
  const pc = createGroupPeerConnection(from);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ type: "group-answer", to: from, sdp: answer.sdp });
    console.log("[RTC] group answer");
  } catch (err) {
    console.error("[RTC] group answer error", err);
  }
}

function handleGroupAnswer(from, sdp) {
  const pc = groupPeerConnections.get(from);
  if (!pc) return;
  pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }))
    .then(() => {
      console.log("[RTC] group answer");
    })
    .catch((err) => {
      console.error("[RTC] group answer error", err);
    });
}

function handleGroupIce(from, candidate) {
  const pc = groupPeerConnections.get(from);
  if (!pc) return;
  pc.addIceCandidate(new RTCIceCandidate(candidate))
    .then(() => {
      console.log("[RTC] group ice");
    })
    .catch((err) => {
      console.error("[RTC] group ice error", err);
    });
}

function removeGroupPeer(peer) {
  const pc = groupPeerConnections.get(peer);
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
  }
  groupPeerConnections.delete(peer);
  groupRemoteStreams.delete(peer);
  removeGroupVideo(peer);
  console.log(`[GROUP] peer removed ${peer}`);
}

function endGroupCall(sendLeave) {
  if (!groupCallActive && !groupCallPending) return;
  if (sendLeave) {
    sendSignal({ type: "group-leave-call" });
  }
  groupCallActive = false;
  groupCallPending = false;
  const peers = Array.from(groupPeerConnections.keys());
  peers.forEach((peer) => {
    removeGroupPeer(peer);
  });
  groupPeerConnections.clear();
  groupRemoteStreams.clear();
  updateGroupUI();
}

async function startScreenShare() {
  if (!callActive || callScope !== "dm") {
    alert("Screen share is only available during a DM call.");
    return;
  }
  if (screenSharing) return;
  if (!localStream) {
    alert("Enable Camera & Mic first.");
    return;
  }

  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });
  } catch (err) {
    console.error("[RTC] screen share error", err);
    return;
  }

  if (!displayStream || displayStream.getVideoTracks().length === 0) {
    return;
  }

  const sender = getVideoSender();
  if (!sender) {
    console.error("[RTC] screen share failed: no video sender");
    return;
  }

  screenStream = displayStream;
  screenTrack = displayStream.getVideoTracks()[0];
  cameraTrack = localStream.getVideoTracks()[0] || null;

  try {
    await sender.replaceTrack(screenTrack);
    localVideo.srcObject = screenStream;
    screenSharing = true;
    updateScreenShareUI();
    console.log("[RTC] screen share started");
  } catch (err) {
    console.error("[RTC] screen share replace error", err);
  }

  screenTrack.onended = () => {
    stopScreenShare();
  };
}

function stopScreenShare() {
  if (!screenSharing) return;
  const sender = getVideoSender();
  const restoreTrack = cameraTrack || (localStream ? localStream.getVideoTracks()[0] : null);

  if (sender && restoreTrack) {
    sender.replaceTrack(restoreTrack).catch((err) => {
      console.error("[RTC] screen share restore error", err);
    });
  }

  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
  }

  screenStream = null;
  screenTrack = null;
  screenSharing = false;
  localVideo.srcObject = localStream;
  updateScreenShareUI();
  console.log("[RTC] screen share stopped");
}

function endCall(sendHangup) {
  const previousScope = callScope;
  const hadCall = callActive || pendingOffer || peerConnection || remoteStreamAttached;
  if (sendHangup) {
    const hangupType = callScope === "dm" ? "dm-hangup" : "hangup";
    sendSignal({ type: hangupType, to: dmCallPeer || undefined });
  }
  if (screenSharing) {
    stopScreenShare();
  }
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  remoteStream = null;
  remoteStreamAttached = false;
  remoteVideo.srcObject = null;
  pendingOffer = null;
  pendingIce = [];
  dmPendingIce = [];
  callConnected = false;
  callActive = false;
  callScope = null;
  dmCallPeer = "";
  dmOutgoingTo = "";
  clearIncomingDm();
  setDmStatus("idle", "");
  if (hadCall) {
    console.log("[RTC] call ended");
    if (previousScope === "dm") {
      addMessage("[SYSTEM] DM call ended");
    } else {
      addMessage("[SYSTEM] Call ended");
    }
    setRtcState("ended");
  }
  updateCallControls();
}

document.getElementById("joinBtn").onclick = () => {
  nickname = document.getElementById("nicknameInput").value.trim();
  roomId = document.getElementById("roomInput").value.trim();

  if (!firebaseReady) {
    alert("Firebase is not connected yet.");
    return;
  }

  if (!nickname || !roomId) {
    alert("Nickname and Room are required");
    return;
  }

  wsStatus.textContent = "connecting...";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${protocol}://${window.location.host}`;
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log("[WS] connected");
    wsStatus.textContent = "connected";
    socket.send(JSON.stringify({
      type: "join",
      nickname,
      roomId
    }));

    joinPanel.style.display = "none";
    chatPanel.style.display = "block";
    mediaPanel.style.display = "block";
    dmPanel.style.display = "block";
    setRtcState("idle");
    setDmStatus("idle", "");
    setGroupCount(0);
    joinFirebaseRoom(nickname, roomId);
  };

  socket.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.log("[WS] Invalid message", event.data);
      return;
    }

    if (data.type === "message") {
      addMessage(`${data.nickname}: ${data.text}`);
    }

    if (data.type === "system") {
      addMessage(`[SYSTEM] ${data.text}`);
    }

    if (data.type === "offer") {
      if (isBusyForCalls()) return;
      pendingOffer = data.sdp;
      addMessage("[SYSTEM] Incoming call");
      setRtcState("ringing");
      updateCallControls();
    }

    if (data.type === "answer") {
      if (!peerConnection) return;
      peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: "answer",
        sdp: data.sdp
      })).then(() => {
        console.log("[RTC] answer received");
        if (!callConnected) {
          addMessage("[SYSTEM] Call accepted");
          callConnected = true;
        }
      }).catch((err) => {
        console.error("[RTC] answer error", err);
      });
    }

    if (data.type === "ice") {
      if (!data.candidate) return;
      const candidate = new RTCIceCandidate(data.candidate);
      if (peerConnection) {
        peerConnection.addIceCandidate(candidate).then(() => {
          console.log("[RTC] ICE candidate added");
        }).catch((err) => {
          console.error("[RTC] ICE add error", err);
        });
      } else {
        pendingIce.push(candidate);
      }
    }

    if (data.type === "hangup") {
      endCall(false);
    }

    if (data.type === "group-join-call") {
      if (data.full) {
        groupCallPending = false;
        setGroupCount(data.count);
        addMessage("[SYSTEM] Room group call is full");
        updateGroupUI();
        return;
      }

      if (typeof data.count === "number") {
        setGroupCount(data.count);
      }

      if (data.you) {
        groupCallActive = true;
        groupCallPending = false;
        if (Array.isArray(data.participants)) {
          data.participants.forEach((peer) => {
            if (peer && peer !== nickname) {
              createGroupPeerConnection(peer);
            }
          });
        }
        updateGroupUI();
        return;
      }

      if (data.from && groupCallActive) {
        if (data.from !== nickname) {
          sendGroupOffer(data.from);
        }
        return;
      }
    }

    if (data.type === "group-leave-call") {
      if (typeof data.count === "number") {
        setGroupCount(data.count);
      }
      if (data.from && data.from !== nickname) {
        removeGroupPeer(data.from);
      }
    }

    if (data.type === "group-offer") {
      if (!groupCallActive && !groupCallPending) return;
      if (groupCallPending) {
        groupCallActive = true;
        groupCallPending = false;
        updateGroupUI();
      }
      if (!data.from || !data.sdp) return;
      handleGroupOffer(data.from, data.sdp);
    }

    if (data.type === "group-answer") {
      if (!groupCallActive && !groupCallPending) return;
      if (groupCallPending) {
        groupCallActive = true;
        groupCallPending = false;
        updateGroupUI();
      }
      if (!data.from || !data.sdp) return;
      handleGroupAnswer(data.from, data.sdp);
    }

    if (data.type === "group-ice") {
      if (!groupCallActive && !groupCallPending) return;
      if (groupCallPending) {
        groupCallActive = true;
        groupCallPending = false;
        updateGroupUI();
      }
      if (!data.from || !data.candidate) return;
      handleGroupIce(data.from, data.candidate);
    }

    if (data.type === "dm-call-request") {
      if (data.from === nickname) return;
      if (isBusyForCalls()) {
        sendSignal({ type: "dm-call-reject", to: data.from, reason: "busy" });
        return;
      }
      setIncomingDm(data.from);
      addMessage(`[SYSTEM] Incoming DM call from ${data.from}`);
    }

    if (data.type === "dm-call-accept") {
      if (!dmOutgoingTo || data.from !== dmOutgoingTo) return;
      dmCallPeer = dmOutgoingTo;
      dmOutgoingTo = "";
      callScope = "dm";
      createPeerConnection();
      setDmStatus("calling", `Calling ${dmCallPeer}...`);
      (async () => {
        try {
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          sendSignal({ type: "dm-offer", sdp: offer.sdp, to: dmCallPeer });
          console.log("[RTC] offer sent");
          callActive = true;
          callConnected = false;
          setRtcState("calling");
          updateCallControls();
        } catch (err) {
          console.error("[RTC] offer error", err);
        }
      })();
    }

    if (data.type === "dm-call-reject") {
      if (data.from) {
        addMessage(`[SYSTEM] DM call rejected by ${data.from}`);
      } else {
        addMessage("[SYSTEM] DM call rejected");
      }
      if (data.reason === "busy") {
        addMessage("[SYSTEM] DM call failed: user is busy");
      }
      if (data.reason === "offline") {
        addMessage("[SYSTEM] DM call failed: user not available");
      }
      dmOutgoingTo = "";
      clearIncomingDm();
      setDmStatus("idle", "");
      updateCallControls();
    }

    if (data.type === "dm-offer") {
      if (!localStream) {
        sendSignal({ type: "dm-call-reject", to: data.from, reason: "busy" });
        return;
      }
      dmCallPeer = data.from;
      if (!peerConnection) {
        callScope = "dm";
        createPeerConnection();
      }
      clearIncomingDm();
      peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: "offer",
        sdp: data.sdp
      })).then(() => {
        return peerConnection.createAnswer();
      }).then((answer) => {
        return peerConnection.setLocalDescription(answer).then(() => answer);
      }).then((answer) => {
        sendSignal({ type: "dm-answer", sdp: answer.sdp, to: data.from });
        console.log("[RTC] answer sent");
        callActive = true;
        callConnected = false;
        setRtcState("calling");
        updateCallControls();
      }).catch((err) => {
        console.error("[RTC] answer error", err);
      });
    }

    if (data.type === "dm-answer") {
      if (!peerConnection) return;
      peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: "answer",
        sdp: data.sdp
      })).then(() => {
        console.log("[RTC] answer received");
      }).catch((err) => {
        console.error("[RTC] answer error", err);
      });
    }

    if (data.type === "dm-ice") {
      if (!data.candidate) return;
      const candidate = new RTCIceCandidate(data.candidate);
      if (peerConnection) {
        peerConnection.addIceCandidate(candidate).then(() => {
          console.log("[RTC] ICE candidate added");
        }).catch((err) => {
          console.error("[RTC] ICE add error", err);
        });
      } else {
        dmPendingIce.push(candidate);
      }
    }

    if (data.type === "dm-hangup") {
      endCall(false);
    }
  };

  socket.onclose = () => {
    console.log("[WS] disconnected");
    wsStatus.textContent = "disconnected";
    endCall(false);
    endGroupCall(false);
  };

  socket.onerror = (err) => {
    console.log("[WS] error", err);
    wsStatus.textContent = "error";
  };
};

document.getElementById("sendBtn").onclick = () => {
  const input = document.getElementById("messageInput");
  const text = input.value.trim();
  if (!text) return;

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.log("[WS] Cannot send, socket not open");
    return;
  }

  sendSignal({
    type: "message",
    text
  });

  input.value = "";
};

startCallBtn.onclick = async () => {
  if (callActive || dmOutgoingTo || dmIncomingFrom || groupCallActive || groupCallPending) return;
  if (!localStream) {
    alert("Enable Camera & Mic first.");
    return;
  }

  callScope = "room";
  createPeerConnection();

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal({ type: "offer", sdp: offer.sdp });
    console.log("[RTC] offer sent");
    callActive = true;
    callConnected = false;
    setRtcState("calling");
    updateCallControls();
  } catch (err) {
    console.error("[RTC] offer error", err);
  }
};

acceptCallBtn.onclick = async () => {
  if (callActive || !pendingOffer || dmOutgoingTo || dmIncomingFrom || groupCallActive || groupCallPending) return;
  if (!localStream) {
    alert("Enable Camera & Mic first.");
    return;
  }

  callScope = "room";
  createPeerConnection();

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription({
      type: "offer",
      sdp: pendingOffer
    }));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignal({ type: "answer", sdp: answer.sdp });
    pendingOffer = null;
    console.log("[RTC] answer sent");
    callActive = true;
    callConnected = false;
    setRtcState("calling");
    updateCallControls();
  } catch (err) {
    console.error("[RTC] answer error", err);
  }
};

hangUpBtn.onclick = () => {
  endCall(true);
};

joinGroupCallBtn.onclick = () => {
  if (groupCallActive || groupCallPending) return;
  if (!localStream) {
    alert("Enable Camera & Mic first.");
    return;
  }
  if (groupCallCount >= GROUP_MAX) {
    alert("Room group call is full.");
    return;
  }
  if (isBusyForCalls()) {
    alert("You are already in a call.");
    return;
  }
  groupCallPending = true;
  console.log("[GROUP] joining room call");
  updateGroupUI();
  sendSignal({ type: "group-join-call" });
};

leaveGroupCallBtn.onclick = () => {
  endGroupCall(true);
  setGroupCount(Math.max(0, groupCallCount - 1));
};

dmAcceptBtn.onclick = () => {
  if (!dmIncomingFrom) return;
  if (!localStream) {
    alert("Enable Camera & Mic first.");
    return;
  }
  dmCallPeer = dmIncomingFrom;
  clearIncomingDm();
  callScope = "dm";
  createPeerConnection();
  sendSignal({ type: "dm-call-accept", to: dmCallPeer });
  callActive = true;
  callConnected = false;
  setRtcState("calling");
  setDmStatus("calling", `Connecting to ${dmCallPeer}...`);
  updateCallControls();
};

dmRejectBtn.onclick = () => {
  if (!dmIncomingFrom) return;
  sendSignal({ type: "dm-call-reject", to: dmIncomingFrom, reason: "rejected" });
  addMessage("[SYSTEM] DM call rejected");
  clearIncomingDm();
  setDmStatus("idle", "");
  updateCallControls();
};

shareScreenBtn.onclick = () => {
  if (screenSharing) {
    stopScreenShare();
  } else {
    startScreenShare();
  }
};

enableMediaBtn.onclick = async () => {
  if (localStream) {
    console.log("[MEDIA] camera enabled");
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    localVideo.srcObject = localStream;
    toggleCameraBtn.disabled = false;
    toggleMicBtn.disabled = false;
    toggleCameraBtn.textContent = "Camera On";
    toggleMicBtn.textContent = "Mic Live";
    updateScreenShareUI();
    console.log("[MEDIA] camera enabled");
    console.log("[MEDIA] mic unmuted");
  } catch (err) {
    console.error("[MEDIA] getUserMedia error", err);
    alert("Could not access camera/microphone. Please check permissions.");
  }
};

toggleCameraBtn.onclick = () => {
  if (!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  if (videoTracks.length === 0) {
    console.log("[MEDIA] No video track");
    return;
  }

  const enabled = videoTracks[0].enabled;
  videoTracks.forEach((track) => {
    track.enabled = !enabled;
  });

  if (enabled) {
    toggleCameraBtn.textContent = "Camera Off";
    console.log("[MEDIA] camera off");
  } else {
    toggleCameraBtn.textContent = "Camera On";
    console.log("[MEDIA] camera enabled");
  }
};

toggleMicBtn.onclick = () => {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length === 0) {
    console.log("[MEDIA] No audio track");
    return;
  }

  const enabled = audioTracks[0].enabled;
  audioTracks.forEach((track) => {
    track.enabled = !enabled;
  });

  if (enabled) {
    toggleMicBtn.textContent = "Mic Muted";
    console.log("[MEDIA] mic muted");
  } else {
    toggleMicBtn.textContent = "Mic Live";
    console.log("[MEDIA] mic unmuted");
  }
};

runDemo.addEventListener("click", () => {
  window.open(window.location.href, "_blank");
  console.log("[WS] Run Demo opened second tab");
});

initFirebase();
