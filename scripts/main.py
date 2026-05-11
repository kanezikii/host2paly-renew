import os
import sys
import time
import random
import requests
import tempfile
import subprocess
import json
from datetime import datetime, timezone, timedelta
from DrissionPage import ChromiumPage, ChromiumOptions

# ==============================================================================
# 配置区域
# ==============================================================================
env_urls = os.environ.get('RENEW_URLS', '')
if env_urls:
    RENEW_URLS = [u.strip() for u in env_urls.replace(';', ',').replace('\n', ',').split(',') if u.strip().startswith('http')]
else:
    RENEW_URLS = [
        "https://host2play.gratis/server/renew?i=b94d43bb-aabc-4425-848a-1885476fa724",
    ]

MAX_RENEW_RETRIES_PER_URL = 50

# ==============================================================================
# CapSolver 验证码破解配置
# ==============================================================================
CAPSOLVER_API_KEY = os.environ.get('CAPSOLVER_API_KEY', '')
HOST2PLAY_SITE_KEY = "6LeUAtQiAAAAADTs_7zmhdpi_78S9bW-zzDFmpV2"  # 你提取出的固定 SiteKey

# ==============================================================================
# 自定义异常 & 日志
# ==============================================================================
def log(msg, level="INFO"):
    prefix = {"INFO": "[INFO]", "WARN": "[WARN]", "ERROR": "[ERROR]"}.get(level, "[INFO]")
    print(f"{prefix} {msg}", flush=True)

# ==============================================================================
# 页面元素提取
# ==============================================================================
def get_server_name(page):
    try:
        ele = page.ele('#serverName', timeout=2)
        if ele:
            return ele.text.strip()
    except Exception:
        pass
    return "未知"

import re

def get_expire_time(page):
    # 尝试原有选择器
    try:
        ele = page.ele('#expireDate', timeout=1)
        if ele and ele.text:
            return ele.text.strip()
    except Exception:
        pass
        
    # 放弃抓取 "Expires in"，直接用正则从页面文本中提取绝对日期 (YYYY/MM/DD HH:MM:SS)
    try:
        body_text = page.ele('xpath://body').text
        match = re.search(r'\d{4}/\d{2}/\d{2}\s\d{2}:\d{2}:\d{2}', body_text)
        if match:
            return match.group(0)
    except Exception:
        pass
        
    return "未知"

def capture_page_screenshot(page, file_name):
    try:
        page.get_screenshot(path=file_name)
        return file_name
    except Exception as e:
        log(f"截图失败: {e}", "WARN")
        return None

# ==============================================================================
# WARP 重连
# ==============================================================================
def restart_warp():
    log("正在重启 WARP 以更换 IP...")
    try:
        old_ip = requests.get("https://api.ipify.org", timeout=10).text
        log(f"当前 IP: {old_ip}")
    except Exception:
        old_ip = "未知"
    try:
        subprocess.run(["sudo", "warp-cli", "--accept-tos", "disconnect"], check=False, timeout=30, capture_output=True)
        time.sleep(3)
        try:
            subprocess.run(["sudo", "warp-cli", "--accept-tos", "registration", "delete"], check=True, timeout=30, capture_output=True)
        except subprocess.CalledProcessError:
            log("删除注册失败（可能未注册）", "WARN")
        subprocess.run(["sudo", "warp-cli", "--accept-tos", "registration", "new"], check=True, timeout=30, capture_output=True)
        time.sleep(3)
        subprocess.run(["sudo", "warp-cli", "--accept-tos", "connect"], check=True, timeout=30, capture_output=True)
        time.sleep(10)
        new_ip = requests.get("https://api.ipify.org", timeout=10).text
        log(f"WARP 重连成功，新 IP: {new_ip}")
        return True
    except Exception as e:
        log(f"WARP 重连失败: {e}", "ERROR")
        return False

# ==============================================================================
# CapSolver 打码请求
# ==============================================================================
def solve_recaptcha_with_capsolver(page_url):
    """调用 CapSolver API 后台静默解决 reCAPTCHA"""
    if not CAPSOLVER_API_KEY:
        log("未配置 CAPSOLVER_API_KEY，跳过打码！", "ERROR")
        return None

    log(f"开始调用 CapSolver，目标 SiteKey: {HOST2PLAY_SITE_KEY}")
    
    payload = {
        "clientKey": CAPSOLVER_API_KEY,
        "task": {
            "type": "ReCaptchaV2TaskProxyless",
            "websiteURL": page_url,
            "websiteKey": HOST2PLAY_SITE_KEY
        }
    }
    
    try:
        res = requests.post("https://api.capsolver.com/createTask", json=payload).json()
        if res.get("errorId") == 1:
            log(f"CapSolver 创建任务失败: {res.get('errorDescription')}", "ERROR")
            return None
        
        task_id = res.get("taskId")
        log(f"CapSolver 任务已创建 (ID: {task_id})，等待解码...")
        
        # 轮询获取结果
        for _ in range(20): # 最多等60秒
            time.sleep(3)
            result_payload = {"clientKey": CAPSOLVER_API_KEY, "taskId": task_id}
            task_res = requests.post("https://api.capsolver.com/getTaskResult", json=result_payload).json()
            
            status = task_res.get("status")
            if status == "ready":
                log("CapSolver 解码成功！")
                return task_res.get("solution", {}).get("gRecaptchaResponse")
            elif status == "processing":
                pass
            else:
                log(f"CapSolver 解码失败: {task_res.get('errorDescription')}", "ERROR")
                return None
        
        log("CapSolver 解码超时", "ERROR")
        return None
    except Exception as e:
        log(f"CapSolver 请求异常: {e}", "ERROR")
        return None

# ==============================================================================
# 单个 URL 续期流程
# ==============================================================================
def renew_single_url(url):
    success = False
    server_name = "未知"
    old_expire = "未知"
    new_expire = "未知"
    screenshot_path = None
    failure_reason = ""
    screenshot_dir = "output/screenshots"
    os.makedirs(screenshot_dir, exist_ok=True)

    for attempt in range(1, MAX_RENEW_RETRIES_PER_URL + 1):
        log(f"{'='*20} 续期尝试 {attempt}/{MAX_RENEW_RETRIES_PER_URL} {'='*20}")
        page = None
        try:
            co = ChromiumOptions()
            co.set_browser_path('/usr/bin/google-chrome')
            co.set_argument('--no-sandbox')
            co.set_argument('--disable-dev-shm-usage')
            co.set_argument('--disable-gpu')
            co.set_argument('--disable-setuid-sandbox')
            co.set_argument('--disable-software-rasterizer')
            co.set_argument('--disable-extensions')
            co.set_argument('--no-first-run')
            co.set_argument('--no-default-browser-check')
            co.set_argument('--disable-popup-blocking')
            co.set_argument('--window-size=1280,720')
            co.set_argument('--log-level=3')
            co.set_argument('--silent')
            user_data_dir = tempfile.mkdtemp()
            co.set_user_data_path(user_data_dir)
            co.auto_port()
            co.headless(False)
            page = ChromiumPage(co)

            page.add_init_js("""
                const getParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) return 'Intel Inc.';
                    if (parameter === 37446) return 'Intel(R) UHD Graphics 630';
                    return getParameter.apply(this, [parameter]);
                };
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
                Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3]});
            """)

            log(f"访问: {url}")
            page.get(url, retry=3)
            time.sleep(random.uniform(5, 8))

            # 预判 Cloudflare 盾
            try:
                cf_box = page.ele('.ctp-checkbox-label', timeout=3)
                if cf_box:
                    log("检测到 Cloudflare 盾，尝试模拟点击...")
                    cf_box.click(by_js=True)
                    time.sleep(10) # 给 CF 留出验证跳转时间
            except Exception:
                pass

            server_name = get_server_name(page)
            old_expire = get_expire_time(page)
            log(f"服务器: {server_name}, 到期时间: {old_expire}")

            page.run_js("""
                const cssSelectors = ['ins.adsbygoogle', 'iframe[src*="ads"]', '.modal-backdrop'];
                cssSelectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => el.remove());
                });
            """)
            time.sleep(2)
            consent_btn = page.ele('tag:button@@text():Consent', timeout=2)
            if consent_btn:
                consent_btn.click()
                time.sleep(3)

            for _ in range(3):
                scroll_y = random.randint(200, 600)
                page.scroll.down(scroll_y)
                time.sleep(random.uniform(0.5, 1.5))
                page.actions.move(random.randint(100, 800), random.randint(100, 500))
                time.sleep(random.uniform(0.5, 1.0))
            time.sleep(random.uniform(1.0, 2.0))

            log("打开续期弹窗...")
            renew_btn1 = page.ele('xpath://button[contains(text(), "Renew server")]', timeout=3)
            if renew_btn1:
                try:
                    renew_btn1.click()
                except:
                    renew_btn1.click(by_js=True)
            else:
                page.run_js("document.querySelectorAll('button').forEach(b => {if(b.textContent.includes('Renew server')) b.click();});")
            time.sleep(3)

            for _ in range(8):
                if page.ele('text:Expires in:', timeout=0.5) or page.ele('text:Deletes on:', timeout=0.5):
                    break
                time.sleep(1)

            renew_btn2 = page.ele('xpath://button[contains(text(), "Renew server")]', timeout=2)
            if renew_btn2:
                try:
                    renew_btn2.click()
                except:
                    renew_btn2.click(by_js=True)
            time.sleep(random.uniform(5, 8))

            # 检查是否直接成功（无需验证码）
            new_expire = get_expire_time(page)
            if new_expire != old_expire and new_expire != "未知":
                log("无需验证码，续期直接成功")
                success = True
                break

            # 触发 CapSolver 破解
            log("启动 CapSolver 后台打码...")
            g_response = solve_recaptcha_with_capsolver(url)
            
            if not g_response:
                failure_reason = "CapSolver 打码失败"
                if attempt < MAX_RENEW_RETRIES_PER_URL:
                    try: page.quit()
                    except: pass
                    page = None
                    restart_warp()
                    continue
                break

            log("打码成功，向页面注入 Token...")
            # 注入 Token
            page.run_js(f'document.getElementById("g-recaptcha-response").innerHTML="{g_response}";')
            time.sleep(1)
            
            # 尝试执行验证通过后的回调函数
            try:
                page.run_js(f'___grecaptcha_cfg.clients[0].Y.Y.callback("{g_response}")')
                log("成功触发 reCAPTCHA 回调！")
            except Exception:
                log("未找到回调函数，尝试点击默认提交...")

            log("点击最终 Renew 按钮")
            final_btn = page.ele('xpath://button[normalize-space(text())="Renew"]', timeout=3)
            if final_btn:
                try:
                    final_btn.click()
                except:
                    final_btn.click(by_js=True)
            
            # 等待服务器响应并刷新页面内容
            time.sleep(12)
            
            new_expire = get_expire_time(page)
            if new_expire != old_expire and new_expire != "未知":
                log(f"到期时间已更新: {old_expire} -> {new_expire}")
                success = True
            else:
                page_text = (page.html or "").lower()
                if any(w in page_text for w in ["successfully", "renewed"]):
                    success = True
                else:
                    failure_reason = "续期后未检测到成功标志"
            break

        except Exception as e:
            log(f"续期尝试异常: {e}", "ERROR")
            failure_reason = f"运行异常: {str(e)[:200]}"
            if attempt < MAX_RENEW_RETRIES_PER_URL:
                if page:
                    try:
                        page.quit()
                    except:
                        pass
                    page = None
                restart_warp()
                continue
            break
        finally:
            if page:
                screen_name = f"host2play-{server_name}-{'success' if success else 'fail'}.png"
                screenshot_path = capture_page_screenshot(page, os.path.join(screenshot_dir, screen_name))
                try:
                    page.quit()
                except:
                    pass

    return {
        "success": success, 
        "server_name": server_name, 
        "old_expire": old_expire, 
        "new_expire": new_expire, 
        "screenshot": screenshot_path, 
        "reason": failure_reason
    }

# ==============================================================================
# Telegram 合并通知发送
# ==============================================================================
def send_consolidated_tg(token, chat_id, results):
    if not token or not chat_id:
        log("未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过通知。", "WARN")
        return
    if not results:
        return

    success_count = sum(1 for r in results if r['success'])
    caption = f"🤖 <b>主机续期合并报告</b>\n"
    caption += f"✅ 成功: {success_count} | ❌ 失败: {len(results) - success_count}\n\n"
    
    for r in results:
        icon = "✅" if r['success'] else "❌"
        detail = f"{r['old_expire']} -> {r['new_expire']}" if r['success'] else r['reason']
        caption += f"{icon} <b>{r['server_name']}</b>: {detail}\n"

    media = []
    files = {}
    
    for i, r in enumerate(results[:10]):
        if r['screenshot'] and os.path.exists(r['screenshot']):
            name = f"photo{i}"
            media_item = {"type": "photo", "media": f"attach://{name}"}
            if len(media) == 0:
                media_item["caption"] = caption
                media_item["parse_mode"] = "HTML"
            media.append(media_item)
            files[name] = open(r['screenshot'], "rb")

    try:
        if media:
            url = f"https://api.telegram.org/bot{token}/sendMediaGroup"
            res = requests.post(url, data={"chat_id": chat_id, "media": json.dumps(media)}, files=files)
        else:
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            res = requests.post(url, data={"chat_id": chat_id, "text": caption, "parse_mode": "HTML"})
        res.raise_for_status()
        log("Telegram 合并通知发送成功")
    except Exception as e:
        log(f"Telegram 合并通知发送异常: {e}", "ERROR")
    finally:
        for f in files.values():
            f.close()

# ==============================================================================
# 主入口
# ==============================================================================
def main():
    tg_token = os.getenv("TG_BOT_TOKEN")
    tg_chat_id = os.getenv("TG_CHAT_ID")
    
    if not RENEW_URLS:
        log("请在 GitHub Secrets 中配置 RENEW_URLS，或在脚本内填写续期链接。", "ERROR")
        sys.exit(1)

    results = []
    for idx, url in enumerate(RENEW_URLS, 1):
        log(f"{'#'*60}")
        log(f"处理第 {idx} 个链接: {url}")
        log(f"{'#'*60}")

        res = renew_single_url(url)
        results.append(res)

    send_consolidated_tg(tg_token, tg_chat_id, results)

    total_success = sum(1 for r in results if r['success'])
    log(f"全部完成，成功 {total_success}/{len(RENEW_URLS)} 个链接")
    
    if total_success < len(RENEW_URLS):
        sys.exit(1)

if __name__ == "__main__":
    main()
