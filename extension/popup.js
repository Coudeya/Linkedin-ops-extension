const accountStatus = document.getElementById("account-status");
const signinBtn = document.getElementById("signin-btn");
const signoutBtn = document.getElementById("signout-btn");

init();

async function init() {
  try {
    const token = await getAuthToken(false);
    const info = await fetchUserInfo(token);
    showSignedIn(info.email);
  } catch {
    showSignedOut();
  }
}

function showSignedIn(email) {
  accountStatus.textContent = `Connecte en tant que ${email}`;
  signinBtn.hidden = true;
  signoutBtn.hidden = false;
}

function showSignedOut() {
  accountStatus.textContent = "Non connecte.";
  signinBtn.hidden = false;
  signoutBtn.hidden = true;
}

signinBtn.addEventListener("click", async () => {
  accountStatus.textContent = "Connexion en cours…";
  try {
    const token = await getAuthToken(true);
    const info = await fetchUserInfo(token);
    showSignedIn(info.email);
  } catch (err) {
    accountStatus.textContent = "Echec de connexion : " + (err.message || err);
  }
});

signoutBtn.addEventListener("click", async () => {
  try {
    const token = await getAuthToken(false);
    await revokeToken(token);
    await removeCachedToken(token);
  } catch {
    /* already signed out */
  }
  showSignedOut();
});

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "no_token"));
        return;
      }
      resolve(token);
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

async function fetchUserInfo(token) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("userinfo_failed");
  return res.json();
}

async function revokeToken(token) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: "POST",
  });
}
