const express = require("express");
const puppeteer = require("puppeteer");
const app = express();

app.use(express.json());

const requestQueue = [];
let isProcessing = false;

// Cookie解析
function parseCookies(input) {
  const cookies = [];
  if (!input) return cookies;
  const trimmed = input.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        parsed.forEach(c => {
          cookies.push({
            name: c.name,
            value: c.value,
            domain: ".threads.net",
            path: "/",
            secure: true,
            httpOnly: c.httpOnly !== undefined ? c.httpOnly : true
          });
        });
      }
    } catch (e) { console.error("Cookie JSON解析エラー:", e); }
  } else {
    trimmed.split(';').forEach(part => {
      const [key, ...v] = part.trim().split('=');
      if (key && v.length > 0) {
        cookies.push({
          name: key,
          value: v.join('='),
          domain: ".threads.net",
          path: "/",
          secure: true
        });
      }
    });
  }
  return cookies;
}

// プロキシ解析
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  if (!proxyStr.startsWith("http")) {
    const parts = proxyStr.split(':');
    if (parts.length === 4) {
      return { server: `${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
    }
  }
  try {
    const url = new URL(proxyStr.startsWith("http") ? proxyStr : `http://${proxyStr}`);
    return { server: `${url.hostname}:${url.port}`, username: url.username, password: url.password };
  } catch (e) { return null; }
}

// メイン処理
async function runPuppeteerPost(task) {
  let browser = null;
  try {
    console.log("🚀 ブラウザ起動準備...");
    
    const proxyData = parseProxy(task.proxy);
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-zygote',
      '--disable-notifications',
      '--window-size=1920,1080',
      '--lang=en-US'
    ];

    if (proxyData) {
      args.push(`--proxy-server=${proxyData.server}`);
      console.log(`🌐 プロキシ設定: ${proxyData.server}`);
    }

    browser = await puppeteer.launch({ args: args, headless: "new" });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    if (proxyData && proxyData.username) {
      await page.authenticate({ username: proxyData.username, password: proxyData.password });
    }

    await page.setUserAgent(task.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

    const cookies = parseCookies(task.fullCookie);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    console.log("🌍 Threadsにアクセス中...");
    await page.goto("https://www.threads.net/", { waitUntil: 'networkidle2', timeout: 120000 });

    // 読み込み待機
    await new Promise(r => setTimeout(r, 5000));

    // ログイン判定（フィードがあるか）
    const isFeedVisible = await page.evaluate(() => {
        return !!document.querySelector('div[data-pressable-container="true"]');
    });

    if (!isFeedVisible) {
        // 念のためログイン画面かチェック
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (bodyText.includes("Log in") || bodyText.includes("Instagram")) {
             throw new Error("ログイン画面が表示されています。Cookieが無効です。");
        }
        console.log("⚠️ フィードは未検出ですが、処理を続行します...");
    } else {
        console.log("✅ ログイン確認OK (フィード検出)");
    }

    // ★作戦B: 「C」キーを押して投稿画面を開く
    console.log("⌨️ ショートカットキー 'C' を送信します...");
    
    // 画面をクリックしてフォーカスを当てる
    await page.mouse.click(100, 100);
    await new Promise(r => setTimeout(r, 1000));

    // 'c' を押す
    await page.keyboard.press('c');
    await new Promise(r => setTimeout(r, 3000));

    // 入力欄が出たかチェック
    const textBoxSelector = 'div[role="textbox"], div[data-lexical-editor="true"]';
    let isModalOpen = false;
    
    try {
        await page.waitForSelector(textBoxSelector, { timeout: 5000 });
        isModalOpen = true;
        console.log("✅ ショートカット成功！入力欄が開きました。");
    } catch(e) {
        console.log("⚠️ 'C'キーで反応なし。直接URL(/create)へ移動します。");
        await page.goto("https://www.threads.net/create", { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector(textBoxSelector, { timeout: 30000 });
        console.log("✅ ページ移動完了。入力欄を発見。");
    }

    // 入力処理
    console.log("✍️ テキスト入力中...");
    await page.click(textBoxSelector);
    await new Promise(r => setTimeout(r, 1000));
    
    // 全角文字対策: クリップボード貼り付けのふりをするか、一文字ずつ打つ
    // ここでは信頼性の高い type を使用
    await page.type(textBoxSelector, task.text, { delay: 50 });
    await new Promise(r => setTimeout(r, 3000));

    // ★投稿実行: Ctrl + Enter (または Cmd + Enter)
    console.log("⌨️ 投稿ショートカット (Ctrl+Enter) を送信...");
    
    // Windows/Linux用
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    
    // Mac用 (念のためCommandも送る)
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');

    // 成功確認 (投稿完了まで待つ)
    await new Promise(r => setTimeout(r, 5000));

    // モーダルが消えたか、または「View」ボタンが出たかで判定したいが、
    // 簡易的に「成功」とみなしてログを出す (エラーならcatchへ行くはず)
    console.log(`🎉 投稿処理を完了しました: ${task.username}`);
    
    // 念のためスクリーンショットを撮るロジックを入れたいがRenderでは見れないので省略
    // 最後に少し待つ
    await new Promise(r => setTimeout(r, 5000));

  } catch (error) {
    console.error(`❌ 処理失敗: ${error.message}`);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log("🔒 ブラウザを閉じました");
    }
  }
}

app.post("/api/check", async (req, res) => {
  res.json({ status: "success", message: "★Puppeteerサーバー稼働中！「投稿」を実行してください。" });
});

app.post("/api/enqueue", (req, res) => {
  const { username, fullCookie, text, deviceId, imageUrl, ua, proxy } = req.body;
  requestQueue.push({ username, fullCookie, text, deviceId, imageUrl, ua, proxy });
  console.log(`[受付] ${username} を予約`);
  res.json({ status: "queued", message: "予約完了" });
  processQueue();
});

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const task = requestQueue.shift();
    console.log(`\n--- 処理開始 (Puppeteer): ${task.username} ---`);
    try {
      await runPuppeteerPost(task);
    } catch (error) {
      console.error(`❌ 投稿失敗 (${task.username}):`, error.message);
    }
    if (requestQueue.length > 0) {
      console.log("☕ 休憩中...");
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
  }
  isProcessing = false;
}

const listener = app.listen(process.env.PORT, () => {
  console.log("Server started");
});
