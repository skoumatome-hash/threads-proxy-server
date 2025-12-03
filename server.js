const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  Cookie文字列から値を精密に抜き出す関数 (デコード対応)
// ---------------------------------------------------------
function getCookieValue(cookieString, key) {
  if (!cookieString) return null;
  // "key=value" または " key=value" を探す正規表現
  const match = cookieString.match(new RegExp('(^|;\\s*)' + key + '=([^;]*)'));
  if (match && match[2]) {
    // %3A などをデコードして返す
    return decodeURIComponent(match[2]);
  }
  return null;
}

// 1. ログイン確認
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, deviceId, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) {
    return res.status(400).json({ status: "error", message: "プロキシまたはCookie情報が不足しています" });
  }

  try {
    const proxyAgent = new HttpsProxyAgent(proxy);
    
    // ★修正: fullCookieから必要な「鍵」を現地で抽出する
    const realSessionId = getCookieValue(fullCookie, "sessionid");
    const realDeviceId = getCookieValue(fullCookie, "ig_did") || deviceId; // なければGASからのIDを使う
    const realCsrf = getCookieValue(fullCookie, "csrftoken");

    if (!realSessionId) {
      throw new Error("Cookie文字列から sessionid が抽出できませんでした。");
    }

    console.log(`Using SessionID: ${realSessionId.substring(0, 5)}...`);

    // ★修正: 正攻法でインスタンス化（ダミーは使わない）
    const threadsAPI = new ThreadsAPI({
      username: username,
      token: realSessionId,  // ★本物のセッションID
      deviceID: realDeviceId, // ★本物のデバイスID
      axiosConfig: { 
        httpAgent: proxyAgent, 
        httpsAgent: proxyAgent,
        headers: {
          'User-Agent': ua,       // ★ADSPOWERのUA
          'Cookie': fullCookie,   // ★ADSPOWERの全Cookie
          'x-csrftoken': realCsrf // ★CSRFトークン
        }
      },
    });

    // ユーザーIDを取得
    const userID = await threadsAPI.getUserIDfromUsername(username);
    
    // プロフィール取得でログイン検証
    const profile = await threadsAPI.getUserProfile(userID);
    
    res.json({ status: "success", message: `★ログイン成功！ Name: ${profile.username}` });

  } catch (error) {
    console.error(`[Login Check] 失敗: ${error.message}`);
    if (error.response) {
      console.log(JSON.stringify(error.response.data));
      // 403 Forbiddenなどの場合
      if (error.response.status === 403) {
         return res.status(403).json({ status: "error", message: "アクセス拒否(403): IP不一致またはCookie無効" });
      }
    }
    res.status(500).json({ status: "error", message: error.message });
  }
});

// 2. 予約受付
app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username} を予約`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

// 3. 処理ワーカー
async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始: ${task.username} ---`);

    try {
      const proxyAgent = new HttpsProxyAgent(task.proxy);
      
      // ワーカー側でも抽出
      const realSessionId = getCookieValue(task.fullCookie, "sessionid");
      const realDeviceId = getCookieValue(task.fullCookie, "ig_did") || task.deviceId;
      const realCsrf = getCookieValue(task.fullCookie, "csrftoken");

      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: realSessionId,
        deviceID: realDeviceId,
        axiosConfig: { 
          httpAgent: proxyAgent, 
          httpsAgent: proxyAgent,
          headers: {
            'User-Agent': task.ua,
            'Cookie': task.fullCookie,
            'x-csrftoken': realCsrf
          }
        },
      });

      await threadsAPI.publish({ text: task.text, image: task.imageUrl });
      console.log(`✅ 投稿成功: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
      if (error.response) {
        console.log(JSON.stringify(error.response.data));
      }
    }

    if (requestQueue.length > 0) {
      console.log("☕ 休憩中 (25秒)...");
      await new Promise((resolve) => setTimeout(resolve, 25000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
