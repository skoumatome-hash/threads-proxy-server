const express = require("express");
const { ThreadsAPI } = require("threads-api");
const { HttpsProxyAgent } = require("https-proxy-agent");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// ---------------------------------------------------------
//  Cookie文字列から値を精密に抜き出す関数
// ---------------------------------------------------------
function getCookieValue(cookieString, key) {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp('(^|;\\s*)' + key + '=([^;]*)'));
  if (match && match[2]) {
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
    
    // ★修正: Cookieの中から必要な情報を全部現地調達する
    const sessionid = getCookieValue(fullCookie, "sessionid");
    const userID = getCookieValue(fullCookie, "ds_user_id"); // ★ここが追加！CookieからIDを抜く
    const realCsrf = getCookieValue(fullCookie, "csrftoken");

    if (!sessionid || !userID) {
      throw new Error("Cookieから sessionid または ds_user_id が抽出できませんでした。");
    }

    console.log(`ID抽出成功: UserID=${userID}, Session=${sessionid.substring(0, 5)}...`);

    const threadsAPI = new ThreadsAPI({
      username: username,
      token: sessionid,
      deviceID: deviceId,
      axiosConfig: { 
        httpAgent: proxyAgent, 
        httpsAgent: proxyAgent,
        headers: {
          'User-Agent': ua,
          'Cookie': fullCookie,
          'x-csrftoken': realCsrf
        }
      },
    });

    // ★修正: エラーが出る「ID検索」はやめて、持ってるIDで直接プロフィールを見る
    const profile = await threadsAPI.getUserProfile(userID);
    
    // ここまで来れば完全にログインできています
    res.json({ status: "success", message: `★完全突破！ Name: ${profile.username}` });

  } catch (error) {
    console.error(`[Login Check] 失敗: ${error.message}`);
    // もし403やリダイレクトなら、Cookie自体が死んでいる
    if (error.response) {
      console.log(JSON.stringify(error.response.data));
      if (error.response.status === 403) {
         return res.status(403).json({ status: "error", message: "Cookieが無効か、IP不一致で弾かれています(403)" });
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
      
      const sessionid = getCookieValue(task.fullCookie, "sessionid");
      const realCsrf = getCookieValue(task.fullCookie, "csrftoken");

      const threadsAPI = new ThreadsAPI({
        username: task.username,
        token: sessionid,
        deviceID: task.deviceId,
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
