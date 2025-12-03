const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// Cookieから値を抜く関数
function getCookieValue(cookieString, key) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^| )' + key + '=([^;]+)'));
  if (match) return match[2];
  return null;
}

// ----------------------------------------
// ★★★ 強制設定用関数 ★★★
// ----------------------------------------
function configureClient(client, proxy, ua, fullCookie) {
  const proxyAgent = new HttpsProxyAgent(proxy);
  
  // 1. プロキシの強制適用
  client.axios.defaults.httpAgent = proxyAgent;
  client.axios.defaults.httpsAgent = proxyAgent;

  // 2. ヘッダーの強制上書き (ライブラリのデフォルトを消す)
  client.axios.defaults.headers.common['User-Agent'] = ua;
  client.axios.defaults.headers.common['Cookie'] = fullCookie;
  
  // 3. CSRFトークンをCookieから抽出してヘッダーにもセット
  const csrf = getCookieValue(fullCookie, "csrftoken");
  if (csrf) {
    client.axios.defaults.headers.common['x-csrftoken'] = csrf;
  }
}

// 1. ログイン確認
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, deviceId, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  try {
    // インスタンス作成 (token等はダミーで一旦作る)
    const threadsAPI = new ThreadsAPI({
      username: username,
      token: "dummy", 
      deviceID: deviceId,
    });

    // ★ここで強制的にADSPOWERの設定を注入する
    configureClient(threadsAPI, proxy, ua, fullCookie);

    // テスト実行
    const userID = await threadsAPI.getUserIDfromUsername(username);
    const profile = await threadsAPI.getUserProfile(userID);
    
    res.json({ status: "success", message: `★ログイン成功！ Name: ${profile.username}` });

  } catch (error) {
    console.error(`[Login Check] 失敗: ${error.message}`);
    if (error.response) {
      console.log(`Status: ${error.response.status}`); // 403 or 302?
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
      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: "dummy",
        deviceID: task.deviceId,
      });

      // ★ここでも強制注入
      configureClient(threadsAPI, task.proxy, task.ua, task.fullCookie);

      await threadsAPI.publish({ text: task.text, image: task.imageUrl });
      console.log(`✅ 投稿成功: ${task.username}`);

    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
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
