const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  ★万能Cookie解析関数 (JSONでも文字列でも対応)
// ---------------------------------------------------------
function parseCookieInput(input) {
  let sessionid = null;
  let userID = null;
  let deviceId = null;
  let headerString = "";

  if (!input) return { sessionid, userID, deviceId, headerString };

  const trimmed = input.trim();

  // A. JSON形式の場合 ([...])
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const cookies = JSON.parse(trimmed);
      const cookieParts = [];
      
      if (Array.isArray(cookies)) {
        cookies.forEach(c => {
          // 値を抽出
          if (c.name === "sessionid") sessionid = decodeURIComponent(c.value);
          if (c.name === "ds_user_id") userID = c.value;
          if (c.name === "ig_did") deviceId = c.value;
          
          // ヘッダー用に整形
          cookieParts.push(`${c.name}=${c.value}`);
        });
        headerString = cookieParts.join("; ");
      }
    } catch (e) {
      console.error("JSON解析エラー:", e.message);
    }
  } 
  // B. 文字列形式の場合 (key=value; ...)
  else {
    headerString = trimmed; // そのまま使う
    
    // Regexで抽出
    const sessionMatch = trimmed.match(/(^|;\s*)sessionid=([^;]*)/);
    if (sessionMatch && sessionMatch[2]) sessionid = decodeURIComponent(sessionMatch[2]);

    const userMatch = trimmed.match(/(^|;\s*)ds_user_id=([^;]*)/);
    if (userMatch && userMatch[2]) userID = userMatch[2];

    const didMatch = trimmed.match(/(^|;\s*)ig_did=([^;]*)/);
    if (didMatch && didMatch[2]) deviceId = didMatch[2];
  }

  return { sessionid, userID, deviceId, headerString };
}

// ---------------------------------------------------------
//  プロキシ形式変換
// ---------------------------------------------------------
function formatProxy(proxyStr) {
  if (!proxyStr) return null;
  if (proxyStr.startsWith("http")) return proxyStr;
  const parts = proxyStr.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }
  return proxyStr;
}

// 1. ログイン確認
app.post("/api/check", async (req, res) => {
  const { username, fullCookie, ua, proxy } = req.body;
  console.log(`[Login Check] ${username}`);

  if (!proxy || !fullCookie) return res.status(400).json({ status: "error", message: "情報不足" });

  try {
    // ★ここで万能解析！
    const { sessionid, userID, headerString } = parseCookieInput(fullCookie);

    if (!sessionid || !userID) {
      return res.status(400).json({ status: "error", message: "Cookieからsessionidまたはds_user_idが見つかりません" });
    }

    // ID一致チェック
    // ADSPOWERのCookieに入っているIDと、G2セルのIDが違っていたら警告
    // (これがズレていると403になります)
    /* if (userID !== username && !username.includes(userID)) {
       console.warn(`警告: スプシのID(${username})とCookieのID(${userID})が不一致`);
    }
    */

    res.json({ 
      status: "success", 
      message: `★解析OK: UserID=${userID}\n(Session: ${sessionid.substring(0,5)}...)` 
    });

  } catch (error) {
    console.error(`[Login Check] エラー: ${error.message}`);
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
      const formattedProxy = formatProxy(task.proxy);
      const proxyAgent = new HttpsProxyAgent(formattedProxy);
      
      // ★ここでも万能解析
      const { sessionid, deviceId, headerString } = parseCookieInput(task.fullCookie);
      
      // I2にJSONが入っていた場合、task.deviceIdよりCookie内のig_didを優先
      const finalDeviceId = deviceId || task.deviceId;

      // ★ここが重要：ライブラリを「認証済み状態」で起動する
      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: sessionid,  // ★本物のセッションID
        deviceID: finalDeviceId,  // ★本物のデバイスID
        axiosConfig: { 
          httpAgent: proxyAgent, 
          httpsAgent: proxyAgent,
          headers: {
            'User-Agent': task.ua,     // ★ADSPOWERのUA
            'Cookie': headerString     // ★整形済みのCookie文字列
          }
        },
      });

      console.log("投稿リクエスト送信...");
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
