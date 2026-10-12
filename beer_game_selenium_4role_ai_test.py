"""
The Beer Game (LA4) - AI EXPERIMENTAL VERSION
4-role Selenium test, including the AI chatbox
=================================================
Opens 4 real Chrome windows, tiled into quadrants, all joined into one
shared multiplayer game - the same structure as the earlier "4up demo" for
the main version - but this one is a genuine TEST, not a demo: every step
records pass/fail, and it ends with a clear summary rather than just
narration.

New in this version: after reaching a real decision week, each role's AI
"Ask for a suggestion" chatbox is exercised - the request is sent, and the
result is checked. Two different outcomes both count as a legitimate pass
here, because this test can't guarantee the AI proxy server is actually
running when it executes:

  - If the proxy IS running with a working key: a real suggestion comes
    back, and clicking "Use this number" fills the order field correctly.
  - If the proxy is NOT running: the request should still fail gracefully,
    with a visible error message rather than a broken page. That's also a
    real thing worth confirming works.

The one thing that is a genuine FAILURE either way: the chatbox elements
not existing at all, or a page-level JavaScript error.

Usage:
    pip install selenium
    python beer_game_selenium_4role_ai_test.py https://your-frontend-url/

All 4 windows connect through RELAY_SERVER_URL, set near the top of this
file, via the game's own "Advanced: change the server address" field -
so file_url only needs to be wherever the game's HTML is served from, it
does not need to already point at this relay server itself.

For the AI part to actually return a real suggestion (not just the
graceful-failure path), start ai-proxy-server first - see that folder's
own instructions, or use start-ai-game.bat.
"""

import sys
import time
import urllib.request
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    TimeoutException, NoSuchElementException,
    ElementNotInteractableException, StaleElementReferenceException,
)

PACE = 0.8
AI_PROXY_HEALTH_URL = "http://localhost:8790/"

# The multiplayer relay every window connects through, set explicitly via
# the game's own "Advanced: change the server address" field rather than
# relying on whatever DEFAULT_SERVER_URL happens to be baked into
# wherever the frontend is hosted. Same relay used elsewhere in this
# project - visiting it directly in a browser should show plain text
# "relay ok", not the game itself.
RELAY_SERVER_URL = "wss://beer-game-xnnq.onrender.com"

ROLES = [
    ("retailer", "Retailer", "top-left"),
    ("wholesaler", "Wholesaler", "top-right"),
    ("distributor", "Distributor", "bottom-left"),
    ("manufacturer", "Manufacturer", "bottom-right"),
]
GAME_WEEKS = 4
ORDER_SEQUENCE = [7, 9]

results = []  # (description, passed: bool, detail: str)


def record(description, passed, detail=""):
    results.append((description, passed, detail))
    mark = "PASS" if passed else "FAIL"
    print(f"  [{mark}] {description}" + (f" - {detail}" if detail else ""))


def say(label, msg):
    print(f"\n>>> [{label}] {msg}")


def new_driver():
    options = Options()
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    return webdriver.Chrome(options=options)


def position_window(driver, quadrant, screen_w=1920, screen_h=1080):
    w, h = screen_w // 2, screen_h // 2
    x = 0 if "left" in quadrant else w
    y = 0 if "top" in quadrant else h
    driver.set_window_rect(x=x, y=y, width=w, height=h)


def wait_click(driver, by, value, timeout=10):
    el = WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, value)))
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
    el.click()
    return el


def type_into(driver, by, value, text, timeout=10):
    """Types character by character. Strips anything outside the Basic
    Multilingual Plane first - ChromeDriver's send_keys() cannot handle
    most emoji and throws immediately if it hits one.

    Waits for the element to be clickable, THEN retries the actual
    interaction a few times if it still throws
    ElementNotInteractableException. This two-layer approach exists
    because a single clickable-check taken a moment before the real
    action isn't airtight: the check can genuinely pass and the DOM can
    still shift in the narrow window before send_keys() actually fires -
    right after a sequential-order gate opens being exactly when this
    surfaced in practice. Each retry re-runs the clickable wait and
    re-fetches the element fresh, rather than reusing a reference that
    might now be stale, which is the standard, well-established mitigation
    for this class of transient interaction failure.
    """
    text = str(text)
    safe_text = "".join(ch for ch in text if ord(ch) <= 0xFFFF)

    last_error = None
    for attempt in range(4):
        try:
            el = WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, value)))
            driver.execute_script("arguments[0].scrollIntoView({behavior:'instant', block:'center'});", el)
            el.clear()
            for ch in safe_text:
                el.send_keys(ch)
                time.sleep(0.06)
            return
        except (ElementNotInteractableException, StaleElementReferenceException) as e:
            last_error = e
            time.sleep(0.4)
    # every retry failed - surface the real error rather than fail silently
    raise last_error


def set_server_url(driver, toggle_id, input_id, server_url):
    """Expands the Advanced section and sets an explicit relay server,
    rather than trusting whatever server happens to be baked into this
    particular frontend build."""
    wait_click(driver, By.ID, toggle_id)
    time.sleep(0.3)
    type_into(driver, By.ID, input_id, server_url)


def host_setup_and_get_code(driver, file_url, weeks):
    driver.get(file_url)
    wait_click(driver, By.ID, "startBtn")
    time.sleep(0.3)
    wait_click(driver, By.ID, "pickMulti")
    time.sleep(0.3)
    wait_click(driver, By.ID, "pickHost")
    time.sleep(0.4)
    type_into(driver, By.ID, "hostName", "Retailer-Host")
    type_into(driver, By.ID, "hostWeeks", str(weeks))
    set_server_url(driver, "toggleAdvancedHost", "hostServerUrl", RELAY_SERVER_URL)
    wait_click(driver, By.ID, "createRoomBtn")
    time.sleep(1.0)
    code = WebDriverWait(driver, 15).until(
        lambda d: d.execute_script("return window.state && state.lobby && state.lobby.code;")
    )
    return code


def guest_join(driver, file_url, name, room_code):
    driver.get(file_url)
    wait_click(driver, By.ID, "startBtn")
    time.sleep(0.3)
    wait_click(driver, By.ID, "pickMulti")
    time.sleep(0.3)
    wait_click(driver, By.ID, "pickJoin")
    time.sleep(0.4)
    type_into(driver, By.ID, "joinName", name)
    type_into(driver, By.ID, "joinCode", room_code)
    set_server_url(driver, "toggleAdvancedJoin", "joinServerUrl", RELAY_SERVER_URL)
    wait_click(driver, By.ID, "joinRoomBtn")
    time.sleep(1.0)


def claim_seat(driver, role_key, team_index=0):
    sel = f'.seat-cell[data-team="{team_index}"][data-role="{role_key}"]'
    wait_click(driver, By.CSS_SELECTOR, sel)


def poll_submit_order(driver, label, qty, week, max_wait_s=8):
    """Waits for this role's gate to open (the sequential submission order
    means not every role's button is available at once) then submits.
    type_into() now does its own robust wait for true interactability, not
    just presence - so this only needs to catch the case where the gate
    never opens at all within max_wait_s, not re-implement that wait itself."""
    try:
        type_into(driver, By.ID, "orderInput", qty, timeout=max_wait_s)
    except TimeoutException:
        record(f"{label} week {week}: submitted order", False, "gate never opened in time")
        return False
    time.sleep(0.15)
    wait_click(driver, By.ID, "submitOrderBtn")
    record(f"{label} week {week}: submitted order", True, f"qty={qty}")
    return True


def poll_confirm_fixed(driver, label, week, max_wait_s=8):
    try:
        wait_click(driver, By.ID, "submitOrderBtn", timeout=max_wait_s)
    except TimeoutException:
        record(f"{label} week {week}: confirmed fixed order", False, "button never appeared")
        return False
    record(f"{label} week {week}: confirmed fixed order", True)
    return True


def test_ai_chatbox(driver, label):
    """Exercises the AI suggestion widget for whichever role currently has
    it on screen. Two distinct outcomes both count as a pass - see the
    module docstring. Only a missing element or a JS error is a failure."""
    print(f"\n  --- AI chatbox check: {label} ---")

    if not driver.find_elements(By.ID, "aiSuggestBtn"):
        record(f"{label}: AI chatbox present on screen", False, "aiSuggestBtn not found")
        return
    record(f"{label}: AI chatbox present on screen", True)

    try:
        type_into(driver, By.ID, "aiQuestionInput", "stock is a bit low, what should I do?")
    except (TimeoutException, NoSuchElementException):
        pass  # question field is optional; absence alone isn't a failure

    js_errors_before = driver.execute_script("return window.__jsErrorCount || 0;")
    wait_click(driver, By.ID, "aiSuggestBtn")

    # wait for the response box to leave its loading state
    outcome = None
    for _ in range(30):  # up to ~15s for a real network round trip
        try:
            box = driver.find_element(By.ID, "aiChatResponse")
            cls = box.get_attribute("class") or ""
            if "ai-chat-success" in cls:
                outcome = "success"
                break
            if "ai-chat-error" in cls:
                outcome = "error"
                break
        except NoSuchElementException:
            pass
        time.sleep(0.5)

    if outcome == "success":
        record(f"{label}: AI returned a live suggestion", True, "proxy server reachable")
        try:
            qty_before = driver.find_element(By.ID, "orderInput").get_attribute("value")
        except NoSuchElementException:
            qty_before = None
        wait_click(driver, By.ID, "aiUseSuggestionBtn")
        time.sleep(0.3)
        qty_after = driver.find_element(By.ID, "orderInput").get_attribute("value")
        record(f"{label}: 'Use this number' fills the order field", qty_after != qty_before,
               f"before={qty_before!r} after={qty_after!r}")
    elif outcome == "error":
        error_text = driver.find_element(By.ID, "aiChatResponse").text
        record(f"{label}: AI proxy unreachable, failed gracefully (not a crash)", True,
               error_text[:80])
    else:
        record(f"{label}: AI chatbox produced a result within 15s", False, "still loading/stuck")

    js_errors_after = driver.execute_script("return window.__jsErrorCount || 0;")
    record(f"{label}: no new JS errors during AI check", js_errors_after == js_errors_before)


def install_error_counter(driver):
    driver.execute_script("""
        window.__jsErrorCount = 0;
        window.addEventListener('error', () => { window.__jsErrorCount++; });
    """)


def check_ai_proxy_reachable():
    try:
        with urllib.request.urlopen(AI_PROXY_HEALTH_URL, timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    if len(sys.argv) < 2:
        print("Usage: python beer_game_selenium_4role_ai_test.py https://your-frontend-url/")
        sys.exit(1)
    file_url = sys.argv[1]

    print("=" * 70)
    print("  THE BEER GAME (AI EXPERIMENTAL) - 4-ROLE TEST, INCLUDING AI")
    print("=" * 70)

    proxy_up = check_ai_proxy_reachable()
    print(f"\nAI proxy server reachable at {AI_PROXY_HEALTH_URL}: {proxy_up}")
    if not proxy_up:
        print("  (not running - the AI checks below will exercise the graceful-")
        print("   failure path instead of a live suggestion. That's still a valid")
        print("   test. Start ai-proxy-server first if you want the live path too.)")

    drivers = {}
    try:
        host_key, host_label, host_quad = ROLES[0]
        say(host_label, "opening the room as host...")
        drivers[host_key] = new_driver()
        position_window(drivers[host_key], host_quad)
        code = host_setup_and_get_code(drivers[host_key], file_url, GAME_WEEKS)
        record("Room created with a valid code", bool(code), f"code={code}")
        install_error_counter(drivers[host_key])
        claim_seat(drivers[host_key], host_key)
        record(f"{host_label}: host claimed their own seat", True)

        for role_key, label, quad in ROLES[1:]:
            say(label, "joining the room...")
            drivers[role_key] = new_driver()
            position_window(drivers[role_key], quad)
            player_name = role_key.capitalize() + "-Player"
            guest_join(drivers[role_key], file_url, player_name, code)
            install_error_counter(drivers[role_key])
            claim_seat(drivers[role_key], role_key)
            record(f"{label}: guest joined and claimed seat", True)
            time.sleep(0.4)

        time.sleep(1.0)
        say(host_label, "starting the game...")
        wait_click(drivers[host_key], By.ID, "startHostedBtn")
        time.sleep(1.5)
        for role_key, label, _ in ROLES:
            on_play_screen = drivers[role_key].execute_script("return window.state && state.screen === 'play';")
            record(f"{label}: reached the play screen", bool(on_play_screen))

        for week in (1, 2):
            print(f"\n{'='*70}\n  WEEK {week} - fixed order, all 4 roles confirm\n{'='*70}")
            for role_key, label, _ in ROLES:
                poll_confirm_fixed(drivers[role_key], label, week)

        print(f"\n{'='*70}\n  WEEK 3 - real decision + AI chatbox check\n{'='*70}")
        for role_key, label, _ in ROLES:
            d = drivers[role_key]
            # wait for this role's turn to actually be unlocked before
            # testing the chatbox, since it only renders on an active
            # decision screen
            unlocked = False
            for _ in range(20):
                if d.find_elements(By.ID, "orderInput"):
                    unlocked = True
                    break
                time.sleep(0.4)
            record(f"{label}: week 3 decision unlocked", unlocked)
            if unlocked:
                test_ai_chatbox(d, label)
                poll_submit_order(d, label, ORDER_SEQUENCE[0], 3)

        print(f"\n{'='*70}\n  WEEK 4 - real decision (no AI re-check, order flow only)\n{'='*70}")
        for role_key, label, _ in ROLES:
            poll_submit_order(drivers[role_key], label, ORDER_SEQUENCE[1], 4)

        for role_key, label, _ in ROLES:
            week_now = drivers[role_key].execute_script("return window.state.teams[0].week;")
            record(f"{label}: session week advanced past 4", week_now > 4, f"week={week_now}")

        print("\nLeaving windows open for 15 seconds so you can look around...")
        time.sleep(15)

    finally:
        for d in drivers.values():
            d.quit()

    print("\n" + "=" * 70)
    print("  SUMMARY")
    print("=" * 70)
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    for desc, ok, detail in results:
        if not ok:
            print(f"  FAILED: {desc}" + (f" ({detail})" if detail else ""))
    print(f"\n  {passed} passed, {failed} failed, {len(results)} total checks.")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
