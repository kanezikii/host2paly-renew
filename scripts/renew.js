const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 环境变量获取
const EMAIL = process.env.H2P_EMAIL;
const PASSWORD = process.env.H2P_PASSWORD;
const TARGET_URL = process.env.RENEW_URL;
const PROXY_JSON = process.env.PROXY_JSON;

const EXTENSION_PATH = path.join(__dirname, 'extensions', 'nopecha', 'unpacked');

async function startProxy() {
    console.log('[初始化] 准备 Hysteria2 代理配置...');
    fs.writeFileSync('config.json', PROXY_JSON);

    console.log('[Hysteria2] starts...');
    const hysteria = spawn('hysteria', ['-c', 'config.json']);
    
    hysteria.stdout.on('data', (data) => console.log(`[Hysteria2 Log]: ${data}`));
    hysteria.stderr.on('data', (data) => console.error(`[Hysteria2 Error]: ${data}`));

    // 等待代理启动
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('[Hysteria2] socks5: 127.0.0.1:10808 预计已就绪');
    return hysteria;
}

async function run() {
    let proxyProcess;
    if (PROXY_JSON) {
        proxyProcess = await startProxy();
    }

    console.log('[Playwright] 启动中，并注入伪装特征...');
    const userDataDir = '/tmp/playwright_user_data';
    
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false, 
        proxy: { server: 'socks5://127.0.0.1:10808' },
        // 伪装成正常的 Windows Chrome 用户
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        args: [
            `--disable-extensions-except=${EXTENSION_PATH}`,
            `--load-extension=${EXTENSION_PATH}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled', // 最关键的一句：擦除自动化指纹
            '--ignore-certificate-errors'
        ]
    });

    const page = await context.newPage();
    console.log('[浏览器] 启动完成...');

    try {
        console.log('[页面] 访问公开续期链接...');
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // 刚进入页面，等5秒让 JS 运行并渲染按钮
        await page.waitForTimeout(5000); 

        const isLoading = await page.locator('text="Loading..."').isVisible();
        if (isLoading) {
            console.log('[警报] 页面卡在 Loading，遭遇后台拦截，尝试强制刷新突破...');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(8000); 
        }

        await page.screenshot({ path: path.join(__dirname, 'screenshots', '1_page_loaded.png'), fullPage: true });
        
        // ==========================================
        // 第一步：点击蓝色的 "Renew server" 触发验证码
        // ==========================================
        console.log('[交互] 查找并点击第一步的 "Renew server" 按钮...');
        const initialRenewBtn = page.locator('text="Renew server"').first();
        
        if (await initialRenewBtn.isVisible()) {
            await initialRenewBtn.click();
            console.log('[交互] 已点击 Renew server，等待验证码弹窗...');
        } else {
            console.log('[警告] 没找到初始的 Renew server 按钮，可能页面未加载完全。');
        }

        // ==========================================
        // 第二步：给 NopeCHA 充足的时间自动做题
        // ==========================================
        console.log('[交互] 等待 NopeCHA 识别并处理图片验证码 (给予 35 秒时间)...');
        await page.screenshot({ path: path.join(__dirname, 'screenshots', '2_captcha_popup.png'), fullPage: true });
        // 免费版的 NopeCHA 选图片比较慢，一定要多给点时间
        await page.waitForTimeout(35000); 

        // ==========================================
        // 第三步：验证码完成后，点击最终的确认按钮
        // ==========================================
        console.log('[交互] 查找并点击弹窗中的最终确认按钮...');
        await page.screenshot({ path: path.join(__dirname, 'screenshots', '3_after_nopecha.png'), fullPage: true });
        
        // 匹配 SweetAlert2 弹窗的确认按钮，或者带有 Confirm/Renew 字样的按钮
        const finalConfirmBtn = page.locator('.swal2-confirm, button:has-text("Confirm"), button:has-text("Renew")').last();
        
        if (await finalConfirmBtn.isVisible()) {
            await finalConfirmBtn.click();
            console.log('[成功] 最终续期按钮已点击！');
            await page.waitForTimeout(5000); // 等待后端反馈
        } else {
            console.log('[跳过] 未找到最终确认按钮。可能：1. NopeCHA 没做对验证码 2. 验证通过后自动提交了。');
        }

        await page.screenshot({ path: path.join(__dirname, 'screenshots', '4_final_result.png'), fullPage: true });
        console.log('[截图] 流程结束，请查看 4_final_result.png 确认结果。');

    } catch (error) {
        console.error('[错误] 运行中断:', error);
        await page.screenshot({ path: path.join(__dirname, 'screenshots', 'error_crash.png'), fullPage: true });
    } finally {
        await context.close();
        if (proxyProcess) proxyProcess.kill();
        console.log('[结束] 任务完成，清理进程。');
    }
}

run();
