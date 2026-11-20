"""
Drives the vendored Workday copilot (vendor/workday-copilot/c_filler.py) for one job.

Auth is already done in TypeScript (`reachWorkdayForm`). This process attaches to that
wizard tab and fills it. It never reconstructs `/apply/applyManually` onto the live URL.

Fill state machine (same one AutoapplyAi / omniclaw / raghuboosetty use):
  reuse_tab → (optional canonical goto only if not on the wizard)
  → fill current step by data-automation-id
  → Next / Save and Continue (bottomNavigation-next)
  → if Errors Found: read the banner, refill those fields, retry twice
  → if the progress-bar step did not change: PARK with the error text
  → Review → Submit → /jobTasks/completed/application

Usage: python workday_fill.py <job.json>
Prints `JR_RESULT {"status": ..., "reason": ...}` as its last line.
"""

import builtins
import json
import os
import re
import sys
import time
import types
import unicodedata
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "workday-copilot"


class Park(Exception):
    """The filler wants a human; the job is parked with this reason."""


def result(status: str, reason: str = "") -> None:
    print("JR_RESULT " + json.dumps({"status": status, "reason": reason}), flush=True)


job = json.loads(Path(sys.argv[1]).read_text())

# ---------- Anthropic → OpenRouter ----------

def _chat(model: str, max_tokens: int, messages: list, system: str | None = None) -> str:
    msgs = ([{"role": "system", "content": system}] if system else []) + [
        {"role": m["role"], "content": m["content"] if isinstance(m["content"], str) else
         "".join(part.get("text", "") for part in m["content"])}
        for m in messages
    ]
    body = json.dumps({"model": job["model"], "max_tokens": max_tokens, "messages": msgs}).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {job['openrouterKey']}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        data = json.loads(res.read())
    return data["choices"][0]["message"]["content"] or ""


class _Messages:
    def create(self, model="", max_tokens=200, messages=(), system=None, **_):
        text = _chat(model, max_tokens, list(messages), system if isinstance(system, str) else None)
        return types.SimpleNamespace(content=[types.SimpleNamespace(text=text)])


class _Anthropic:
    def __init__(self, *_, **__):
        self.messages = _Messages()


sys.modules["anthropic"] = types.SimpleNamespace(Anthropic=_Anthropic)

# ---------- Config, then the filler with locale literals swapped ----------

sys.path.insert(0, str(VENDOR))
import d_config  # noqa: E402

for key, value in job["config"].items():
    setattr(d_config, key, value)

phone = job["phoneCountry"]  # e.g. {"name": "India", "code": "+91"}
source = (VENDOR / "c_filler.py").read_text()
for old, new in [
    ('cc_el.fill("Australia")', f'cc_el.fill({phone["name"]!r})'),
    ('"australia" in txt.lower() or "+61" in txt', f'{phone["name"].lower()!r} in txt.lower() or {phone["code"]!r} in txt'),
    ('addr.get("state_abbr", "VIC")', 'addr.get("state_abbr", "")'),
    ("current_url = page.url\n", "current_url = _jr_page_key(page)\n"),
    ('page_text = page.inner_text("body").lower()', "page_text = _jr_page_text(page)"),
    ("page.wait_for_function(_CONTENT_JS, timeout=12000)", "_jr_wait_ready(page)"),
    # The skip words ("country", "state", "title") are for short personal-info labels; a question
    # like "...sponsorship to work in the country of the posting" must still be answered.
    ("page.goto(url, timeout=60000)", "_jr_goto(page, url)"),
    ("if any(skip in clean_label.lower() for skip in SCREENING_SKIP_LABELS):",
     "if len(clean_label) < 40 and any(skip in clean_label.lower() for skip in SCREENING_SKIP_LABELS):"),
    ('"salutation", "title", "given name"', '"salutation", "prefix", "title", "given name"'),
    (
        'next_btn   = _find_btn("bottom-navigation-next-btn", "Next", "Save and Continue", "saveAndContinueButton")',
        'next_btn   = _find_btn("bottom-navigation-next-btn", "bottom-navigation-next-button", "bottomNavigation-next", "Next", "Save and Continue", "saveAndContinueButton")',
    ),
    (
        '"[data-automation-id=\'errors-found\'], "\n'
        '                        "[class*=\'error-container\'], "\n'
        '                        "[data-automation-id=\'validationError\']"',
        '"[data-automation-id=\'errors-found\'], "\n'
        '                        "[data-automation-id=\'errorList\'], "\n'
        '                        "[data-automation-id=\'validationError\']"',
    ),
    (
        '                    print(f"  Errors Found banner detected — re-filling and retrying "\n'
        '                          f"(attempt {_retry + 1}/2)...")',
        '                    print(f"  Errors Found: {_jr_error_text(page)}")\n'
        '                    _jr_fill_school(page)\n'
        '                    _jr_clear_invalid_urls(page)\n'
        '                    print(f"  Errors Found banner detected — re-filling and retrying "\n'
        '                          f"(attempt {_retry + 1}/2)...")',
    ),
    (
        "                            if (t === 'salutation' || t === 'salutation *' ||\n"
        "                                    t === 'salutation*') return true;",
        "                            if (t === 'salutation' || t === 'salutation *' ||\n"
        "                                    t === 'salutation*' || t === 'prefix' ||\n"
        "                                    t === 'prefix *' || t === 'prefix*') return true;",
    ),
    (
        '            on_login_page = (\n'
        '                "applymanually" in current_url_lower and\n'
        '                not any(x in page_text for x in [\n'
        '                    "first name", "work experience", "employment history",\n'
        '                    "education", "upload", "resume", "screening"\n'
        '                ])\n'
        '            )',
        '            on_login_page = (not _jr_on_wizard(page)) and (\n'
        '                "applymanually" in current_url_lower and\n'
        '                not any(x in page_text for x in [\n'
        '                    "first name", "given name", "work experience", "employment history",\n'
        '                    "education", "upload", "resume", "screening"\n'
        '                ])\n'
        '            )',
    ),
    (
        '        "button[data-automation-id=\'legalNameSection_salutation\']",\n'
        '        "button[data-automation-id=\'salutation\']",\n'
        '        "button[data-automation-id=\'nameTitle\']",\n'
        '        "button[data-automation-id=\'title\']",',
        '        "button[data-automation-id=\'legalNameSection_salutation\']",\n'
        '        "button[data-automation-id=\'legalNameSection_title\']",\n'
        '        "button[data-automation-id=\'legalNameSection_prefix\']",\n'
        '        "button[data-automation-id=\'salutation\']",\n'
        '        "button[data-automation-id=\'prefix\']",\n'
        '        "button[data-automation-id=\'nameTitle\']",\n'
        '        "button[data-automation-id=\'title\']",',
    ),
]:
    if old not in source:
        result("parked", f"Workday filler changed upstream; cannot patch {old!r}")
        sys.exit(1)
    source = source.replace(old, new)

filler = types.ModuleType("c_filler")
filler.__file__ = str(VENDOR / "c_filler.py")
sys.modules["c_filler"] = filler


def _jr_page_key(page) -> str:
    try:
        step = page.evaluate(
            """() => {
                const el = document.querySelector("[data-automation-id='progressBarActiveStep']");
                const h = document.querySelector("h2, h3");
                return (el ? el.innerText : "") + "|" + (h ? h.innerText : "");
            }"""
        )
    except Exception:
        step = ""
    return f"{page.url}#{step}"


def _jr_page_text(page) -> str:
    """Page text without the step bar, whose "Review" and "Voluntary Disclosures" labels are on every step."""
    return page.evaluate(
        """() => {
            const main = document.querySelector("[data-automation-id='applyFlowPage']") || document.body;
            const bar = document.querySelector("[data-automation-id='progressBar']");
            const text = main.innerText || "";
            return (bar ? text.replace(bar.innerText || "", " ") : text).toLowerCase();
        }"""
    )


_READY_JS = """() => {
    const main = document.querySelector("[data-automation-id='applyFlowPage']") || document.body;
    const busy = [...main.querySelectorAll("*")].some(e => e.offsetParent && e.children.length === 0
        && e.textContent.trim() === "Loading");
    const fields = main.querySelectorAll("[data-automation-id^='formField-']").length;
    const review = [...document.querySelectorAll("h1,h2,h3")].some(h => h.textContent.trim().toLowerCase() === "review");
    return { busy, n: fields + (review ? 1000 : 0) };
}"""


def _jr_wait_ready(page, timeout: float = 30.0) -> None:
    """Workday renders a step in pieces; wait until nothing says Loading and the fields stop changing."""
    last = -1
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            state = page.evaluate(_READY_JS)
        except Exception:
            state = {"busy": True, "n": 0}
        if not state["busy"] and state["n"] > 0 and state["n"] == last:
            return
        last = -1 if state["busy"] else state["n"]
        time.sleep(1.5)


def _jr_canonical_apply(url: str) -> str:
    """One `/apply/applyManually` on the posting path. Query strings and stacked tails drop."""
    try:
        from urllib.parse import urlsplit, urlunsplit
        parts = urlsplit(url)
        path = parts.path.rstrip("/")
        while True:
            lower = path.lower()
            stripped = False
            for suffix in ("/apply/applymanually", "/applymanually", "/apply"):
                if lower.endswith(suffix):
                    path = path[: len(path) - len(suffix)]
                    stripped = True
                    break
            if not stripped:
                break
        if "/job/" not in path.lower():
            return url
        return urlunsplit((parts.scheme, parts.netloc, path + "/apply/applyManually", "", ""))
    except Exception:
        return url


def _jr_on_wizard(page) -> bool:
    try:
        return bool(
            page.query_selector("[data-automation-id='progressBarActiveStep']")
            or page.query_selector("[data-automation-id='legalNameSection_firstName']")
            or page.query_selector("[data-automation-id='legalNameSection_lastName']")
            or page.query_selector("[data-automation-id='applyFlowPage']")
            or page.query_selector("[data-automation-id='bottomNavigation-next']")
            or page.query_selector("[data-automation-id='bottom-navigation-next-button']")
            or page.query_selector("[data-automation-id='bottom-navigation-next-btn']")
        )
    except Exception:
        return False


def _jr_error_text(page) -> str:
    try:
        return page.evaluate(
            """() => {
                const sel = [
                  "[data-automation-id='errorList']",
                  "[data-automation-id='error']",
                  "[data-automation-id='errorMessage']",
                  "[data-automation-id='formFieldErrorMessage']",
                  "[data-automation-id='errorBanner']",
                  "[data-automation-id='errors-found']",
                  "[aria-live='assertive']",
                  "[role='alert']",
                ].join(",");
                const texts = [...document.querySelectorAll(sel)]
                  .map(n => (n.innerText || "").replace(/\\s+/g, " ").trim())
                  .filter(t => t && t.length < 400 && /error|required/i.test(t) && !/success/i.test(t));
                if (texts.length) return [...new Set(texts)].join(" | ").slice(0, 500);
                const m = (document.body.innerText || "").match(/Errors Found[\\s\\S]{0,600}/i);
                return m && !/success/i.test(m[0]) ? m[0].replace(/\\s+/g, " ").trim().slice(0, 500) : "";
            }"""
        ) or ""
    except Exception:
        return ""


def _jr_goto(page, url: str) -> None:
    """Stay on the wizard the runner already opened. Never stack applyManually onto a query string."""
    if _jr_on_wizard(page):
        print("  Already on the Workday wizard — not navigating")
        return
    target = _jr_canonical_apply(url or page.url)
    here = _jr_canonical_apply(page.url) if page.url else ""
    if "/apply/" in (page.url or "").lower() and here == target:
        print("  Already on the Workday apply URL — not navigating")
        return
    print(f"  Opening Workday form: {target}")
    for attempt in range(3):
        try:
            page.goto(target, timeout=60000, wait_until="domcontentloaded")
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3)


filler._jr_goto = _jr_goto
filler._jr_page_key = _jr_page_key
filler._jr_page_text = _jr_page_text
filler._jr_wait_ready = _jr_wait_ready
filler._jr_error_text = _jr_error_text
filler._jr_canonical_apply = _jr_canonical_apply
filler._jr_on_wizard = _jr_on_wizard
exec(compile(source, filler.__file__, "exec"), filler.__dict__)
filler.APPLICANT_FILE = Path(job["applicantPath"])

# Workday renders one empty, undeletable block per required section. The copilot always clicks
# Add first, which leaves that block blank and fails validation; fill the blank block instead.
_SECTION_KEY = {"work experience": "jobTitle", "education": "school"}
_original_add = filler._click_section_add


def _click_section_add(page, section_keyword: str) -> bool:
    key = next((v for k, v in _SECTION_KEY.items() if k in section_keyword.lower()), None)
    if key == "school" and page.evaluate(
        """() => [...document.querySelectorAll("[data-automation-id='formField-school'], [data-automation-id='formField-schoolName']")].some(row => {
            const text = row.innerText || '';
            if (/0 items selected/i.test(text)) return true;
            if (/\\d+ items? selected/i.test(text)) return false;
            return [...row.querySelectorAll('input')].some(i => i.offsetParent && !i.value.trim());
        })"""
    ):
        return True
    if key and key != "school" and page.evaluate(
        """(k) => [...document.querySelectorAll(`[data-automation-id='formField-${k}']`)].some(row => {
            const text = row.innerText || '';
            if (/0 items selected/i.test(text)) return true;
            return [...row.querySelectorAll('input')].some(i => i.offsetParent && !i.value.trim());
        })""",
        key,
    ):
        return True
    return _original_add(page, section_keyword)


filler._click_section_add = _click_section_add


def _filled_blocks(field_id: str):
    """The copilot counts block headings, which includes the blank default block."""
    return lambda page: page.evaluate(
        """(k) => [...document.querySelectorAll(`[data-automation-id='formField-${k}']`)].filter(row => {
            const text = row.innerText || '';
            if (/\\d+ items? selected/i.test(text) && !/0 items selected/i.test(text)) return true;
            return [...row.querySelectorAll('input')].some(i => i.offsetParent && i.value.trim());
        }).length""",
        field_id,
    )


filler._count_existing_work_entries = _filled_blocks("jobTitle")
filler._count_existing_edu_entries = lambda page: page.evaluate(
    """() => [...document.querySelectorAll("[data-automation-id='formField-school'], [data-automation-id='formField-schoolName']")].filter(row => {
        const text = row.innerText || '';
        return /\\d+ items? selected/i.test(text) && !/0 items selected/i.test(text);
    }).length"""
)


def _reset_section(page, section: str, text_fields: list) -> None:
    """Start the history from one empty block, so an earlier attempt's leftovers never get sent."""
    sec = page.locator(f"[role='group'][aria-labelledby='{section}-section']")
    if sec.count() == 0:
        return
    for _ in range(12):
        dels = sec.get_by_role("button", name="Delete", exact=True)
        if dels.count() == 0:
            break
        dels.last.click()
        time.sleep(0.8)
    for fid in text_fields:
        for box in sec.locator(f"[data-automation-id='formField-{fid}'] input, [data-automation-id='formField-{fid}'] textarea").all():
            if box.is_visible() and box.input_value():
                box.fill("")


def _wrap_reset(original, section: str, text_fields: list):
    def run(page, *args, **kwargs):
        _reset_section(page, section, text_fields)
        return original(page, *args, **kwargs)
    return run


filler._fill_work_experience = _wrap_reset(
    filler._fill_work_experience, "Work-Experience", ["jobTitle", "companyName", "location", "roleDescription"]
)
filler._fill_education = _wrap_reset(filler._fill_education, "Education", ["schoolName", "school", "gradeAverage"])

_original_exp_dates = filler._fill_exp_dates


def _date_digits_shown(field, want: list[str]) -> bool:
    shown = [s.strip() for s in field.locator("[data-automation-id$='-display']").all_inner_texts()]
    nums = [s.lstrip("0") or "0" for s in shown if re.fullmatch(r"\d+", s)]
    return nums == [s.lstrip("0") or "0" for s in want]


def _type_spin_date(field, value: str) -> bool:
    """
    `value` is DD/MM/YYYY, MM/YYYY or YYYY. A three-part date is typed into each
    spinbutton on its own; month/year still uses one keyboard stream because two
    month digits move focus to the year.
    """
    bits = [p for p in value.split("/") if p]
    d = field.locator("input[data-automation-id='dateSectionDay-input']")
    m = field.locator("input[data-automation-id='dateSectionMonth-input']")
    y = field.locator("input[data-automation-id='dateSectionYear-input']")
    try:
        y.first.wait_for(state="attached", timeout=5000)
    except Exception:
        return False
    page = field.page
    if len(bits) == 3 and d.count():
        want = [bits[0].zfill(2), bits[1].zfill(2), bits[2]]
        stream = "".join(want)
        for _ in range(2):
            field.scroll_into_view_if_needed()
            time.sleep(0.3)
            for box in (y, m, d):
                if box.count():
                    box.first.focus()
                    page.keyboard.press("Backspace")
                    page.keyboard.press("Backspace")
            d.first.focus()
            page.keyboard.type(stream, delay=70)
            page.keyboard.press("Tab")
            time.sleep(0.4)
            if _date_digits_shown(field, want):
                return True
        return False
    if len(bits) >= 2 and m.count():
        want = [bits[-2].zfill(2), bits[-1]]
        first = m
    else:
        want = [bits[-1]]
        first = y
    for _ in range(2):
        field.scroll_into_view_if_needed()
        time.sleep(0.4)
        first.first.focus()
        for digits in want:
            page.keyboard.press("Backspace")
            page.keyboard.type(digits, delay=60)
        page.keyboard.press("Tab")
        time.sleep(0.3)
        if _date_digits_shown(field, want):
            return True
    return False


def _last_panel(page, section: str):
    panels = page.locator(f"[role='group'][aria-labelledby^='{section}-'][aria-labelledby$='-panel']")
    return panels.last if panels.count() else None


def _fill_exp_dates(page, start: str, end: str, is_current: bool) -> bool:
    """New work blocks are appended, so the block being filled is always the last one."""
    target = _last_panel(page, "Work-Experience")
    if target is None or "/" not in (start or ""):
        return _original_exp_dates(page, start, end, is_current)
    ok = _type_spin_date(target.locator("[data-automation-id='formField-startDate']"), start)
    end_val = (end or "").strip().lower()
    if not is_current and "/" in end_val:
        ok = _type_spin_date(target.locator("[data-automation-id='formField-endDate']"), end) and ok
    print(f"      Dates {start} – {end or 'Present'}: {'ok' if ok else 'FAILED'}")
    return ok


_original_edu_dates = filler._fill_edu_dates


def _fill_edu_dates(page, start: str, end: str) -> bool:
    target = _last_panel(page, "Education")
    if target is None:
        return _original_edu_dates(page, start, end)
    ok = True
    if start:
        ok = _type_spin_date(target.locator("[data-automation-id='formField-firstYearAttended']"), start.split("/")[-1])
    if end and end != "Present":
        ok = _type_spin_date(target.locator("[data-automation-id='formField-lastYearAttended']"), end.split("/")[-1]) and ok
    print(f"      Years {start} – {end}: {'ok' if ok else 'FAILED'}")
    return True


filler._fill_exp_dates = _fill_exp_dates
filler._fill_edu_dates = _fill_edu_dates


def _clear_skills(page, *_args, **_kwargs) -> None:
    """The copilot fuzzy-matches skills into unrelated rows ("C++" → "C-TPAT"); the field is optional, so leave it empty."""
    pills = page.locator("[data-automation-id='formField-skills'] [data-automation-id='selectedItem']")
    for _ in range(80):
        if pills.count() == 0:
            break
        pills.first.focus()
        page.keyboard.press("Delete")
        time.sleep(0.2)
    print(f"    Skills: left empty ({pills.count()} remaining)")


filler._fill_skills = _clear_skills

def _clear_uploads(page) -> None:
    """Drafts keep earlier attempts' uploads, and a full list hides the file input; send the resume once."""
    deletes = page.locator("button[data-automation-id='delete-file']")
    for _ in range(10):
        if deletes.count() == 0:
            break
        deletes.first.click()
        time.sleep(0.8)


_original_work = filler._fill_work_experience


def _fill_work_experience(page, *args, **kwargs):
    _clear_uploads(page)
    return _original_work(page, *args, **kwargs)


filler._fill_work_experience = _fill_work_experience

_original_personal = filler._fill_personal_info


def _fill_personal_info(page, *args, **kwargs):
    """Prefix is JioStar's salutation; fill it before the copilot looks for 'Salutation'."""
    result = _original_personal(page, *args, **kwargs)
    _jr_fix_required(page)
    return result


filler._fill_personal_info = _fill_personal_info

_original_screening = filler._fill_screening_questions


def _jr_field(page, label_re: str):
    field = page.locator("[data-automation-id^='formField-']").filter(
        has=page.locator("label", has_text=re.compile(label_re, re.I))
    )
    if field.count() and field.first.is_visible():
        return field.first
    return None


def _jr_fold(text: str) -> str:
    """Workday India lists use macrons (Haryāna); fold those so 'Haryana' still matches."""
    return "".join(c for c in unicodedata.normalize("NFKD", text or "") if not unicodedata.combining(c)).lower()


def _jr_option_text(opt) -> str:
    try:
        return (
            (opt.get_attribute("data-automation-label") or "")
            or (opt.get_attribute("aria-label") or "")
            or (opt.inner_text() or "")
        ).strip()
    except Exception:
        return ""


def _jr_list_open(page) -> bool:
    try:
        for el in page.query_selector_all("[role='listbox'], [data-automation-widget='wd-popup']"):
            if el.is_visible():
                return True
        return False
    except Exception:
        return False


def _jr_active_listbox(page):
    boxes = []
    for sel in ("[role='listbox']", "[data-automation-widget='wd-popup']"):
        for el in page.query_selector_all(sel):
            try:
                if el.is_visible():
                    boxes.append(el)
            except Exception:
                continue
    return boxes[-1] if boxes else None


def _jr_visible_options(page):
    opts = []
    seen = set()
    box = _jr_active_listbox(page)
    scope = [box] if box else [page]
    for root in scope:
        for sel in (
            "[data-automation-id='promptOption']",
            "[data-automation-id='listItem']",
            "[data-automation-id='dropdownOption']",
            "[role='option']",
        ):
            for opt in root.query_selector_all(sel):
                try:
                    if not opt.is_visible():
                        continue
                    txt = _jr_option_text(opt)
                    if not txt or txt in seen:
                        continue
                    seen.add(txt)
                    opts.append(opt)
                except Exception:
                    continue
    return opts


def _jr_click_matching_option(opts, values: list[str]) -> str:
    wanted = [(_jr_fold(v), v) for v in values if v]
    scored: list[tuple[int, object, str]] = []
    for opt in opts:
        txt = _jr_option_text(opt)
        folded = _jr_fold(txt)
        if not folded or folded in ("select one", "all", "no items", "no items."):
            continue
        for w, _orig in wanted:
            if not w:
                continue
            if w == folded:
                opt.evaluate("el => { el.scrollIntoView({block:'center'}); el.click(); }")
                time.sleep(0.3)
                return txt
            if len(w) >= 10 and w in folded:
                scored.append((len(w), opt, txt))
    if scored:
        scored.sort(key=lambda row: -row[0])
        _opt, txt = scored[0][1], scored[0][2]
        _opt.evaluate("el => { el.scrollIntoView({block:'center'}); el.click(); }")
        time.sleep(0.3)
        return txt
    return ""


def _jr_looks_like_countries(opts) -> bool:
    texts = [_jr_fold(_jr_option_text(o)) for o in opts]
    return sum(1 for t in texts if t.startswith(("afghan", "aland", "albania", "algeria", "andorra", "angola"))) >= 2


def _jr_click_named_option(page, value: str) -> str:
    """Click a visible option whose text is exactly `value`, then a word-boundary contains match."""
    locators = [
        page.locator("[role='listbox'] [data-automation-id='promptOption']"),
        page.locator("[role='listbox'] [role='option']"),
        page.locator("[data-automation-widget='wd-popup'] [data-automation-id='promptOption']"),
    ]
    exact = re.compile(rf"^{re.escape(value)}$", re.I)
    word = re.compile(rf"(^|\b){re.escape(value)}(\b|$)", re.I)
    for loc in locators:
        hit = loc.filter(has_text=exact)
        if hit.count():
            hit.first.evaluate("el => { el.scrollIntoView({block:'center'}); el.click(); }")
            time.sleep(0.3)
            return value
    for loc in locators:
        hit = loc.filter(has_text=word)
        if hit.count():
            txt = (hit.first.get_attribute("data-automation-label") or hit.first.inner_text() or value).strip()
            hit.first.evaluate("el => { el.scrollIntoView({block:'center'}); el.click(); }")
            time.sleep(0.3)
            return txt
    return ""


def _jr_pick_open_options(page, values: list[str]) -> str:
    """Click a visible option (unicode-folded). Country lists are filtered by typing India."""
    wanted = [v for v in values if v]
    if not wanted:
        return ""
    time.sleep(0.3)
    opts = _jr_visible_options(page)
    if _jr_looks_like_countries(opts):
        print("    country list — searching India")
        wanted = ["India"]
    picked = _jr_click_matching_option(opts, wanted)
    if picked:
        return picked
    search = page.locator(
        "[data-automation-id='promptSearchField'] input, "
        "[data-automation-widget='wd-popup'] input, "
        "input[data-automation-id='searchBox'], "
        "input[placeholder*='Search' i]"
    ).first
    for value in wanted:
        typed = False
        if search.count():
            try:
                search.click(timeout=1500)
                search.fill("")
                search.type(value, delay=40)
                typed = True
                time.sleep(0.6)
            except Exception:
                typed = False
        if not typed:
            page.keyboard.type(value, delay=40)
            time.sleep(0.6)
        picked = _jr_click_matching_option(_jr_visible_options(page), wanted) or _jr_click_named_option(page, value)
        if picked:
            return picked
    return ""


def _jr_close_menus(page) -> None:
    page.keyboard.press("Escape")
    time.sleep(0.15)
    page.keyboard.press("Escape")
    time.sleep(0.15)


def _jr_button_for_label(page, label_re: str):
    """The button in this label's own formField — not Gender when the label is Citizenship."""
    return page.evaluate(
        """(src) => {
            const re = new RegExp(src, 'i');
            for (const lbl of document.querySelectorAll('label, [data-automation-id$="Label"]')) {
                const t = (lbl.textContent || '').replace(/\\*/g, '').replace(/\\s+/g, ' ').trim();
                if (!re.test(t) || t.length > 80) continue;
                const row = lbl.closest("[data-automation-id^='formField']") || lbl.parentElement;
                const btn = [...(row ? row.querySelectorAll('button') : [])].find(b => b.offsetParent);
                if (btn) {
                    return {
                        id: btn.id || '',
                        auto: btn.getAttribute('data-automation-id') || '',
                        text: (btn.innerText || '').trim().slice(0, 60),
                        label: t,
                    };
                }
            }
            return null;
        }""",
        label_re,
    )


def _jr_click_info(page, info) -> bool:
    if not info:
        return False
    sel = None
    if info.get("id"):
        sel = f"#{info['id']}"
    elif info.get("auto"):
        sel = f"[data-automation-id='{info['auto']}']"
    if not sel:
        return False
    el = page.query_selector(sel)
    if not el or not el.is_visible():
        return False
    try:
        parent = el.evaluate_handle("el => el.parentElement")
        overlay = parent.query_selector("[data-automation-id='click_filter']") if parent else None
    except Exception:
        overlay = None
    (overlay or el).evaluate("el => { el.scrollIntoView({block:'center'}); el.click(); }")
    time.sleep(0.35)
    return True


def _jr_select_by_label(page, label_re: str, values: list[str]) -> None:
    _jr_close_menus(page)
    info = _jr_button_for_label(page, label_re)
    field = _jr_field(page, label_re)
    shown = (info or {}).get("text") or (field.inner_text() if field else "")
    if shown and any(v.lower() in shown.lower() for v in values if v and len(v) > 2):
        if "select one" not in shown.lower() and "0 items" not in shown.lower():
            return
    opened = _jr_click_info(page, info)
    if not opened and field:
        btn = field.locator("button").first
        try:
            (btn if btn.count() else field).click(timeout=2500)
            opened = True
            time.sleep(0.35)
        except Exception:
            opened = False
    if not opened:
        print(f"    {label_re}: no button")
        return
    picked = _jr_pick_open_options(page, values)
    if not picked:
        sample = page.evaluate(
            """() => [...document.querySelectorAll("[role='listbox'] [role='option'], [role='listbox'] [data-automation-id='promptOption']")]
                .slice(0, 16)
                .map(e => (e.getAttribute('data-automation-label') || e.innerText || '').trim())"""
        )
        print(f"    {label_re} ({(info or {}).get('label')}): no match in {sample}")
        _jr_close_menus(page)
        return
    print(f"    {label_re} → {picked}")
    time.sleep(0.35)
    if _jr_list_open(page) and re.search(r"hear|source of hire|referral", label_re, re.I):
        nested = _jr_pick_open_options(page, values + ["LinkedIn", "Company Website", "Job Board", "Careers Site"])
        if nested:
            print(f"    {label_re} (nested) → {nested}")
    _jr_close_menus(page)


def _jr_fill_state(page, state: str) -> None:
    """Click the State row's own button. `#address--countryRegion` is also used by phone country."""
    _jr_select_by_label(page, r"^state(\b|/|$)", [state, "Haryana"])


def _jr_fix_required(page) -> None:
    """Fill the two Workday widgets the copilot misses: source-of-hire multi-select and State button."""
    try:
        active = page.locator("[data-automation-id='progressBarActiveStep']").inner_text()
        if re.search(r"review", active, re.I):
            print("    review step — leaving fields alone")
            return
    except Exception:
        pass
    addr = {}
    try:
        addr = json.loads(Path(job["applicantPath"]).read_text()).get("address") or {}
    except Exception:
        pass
    state = addr.get("state") or "Haryana"
    source = (job.get("config") or {}).get("REFERRAL_SOURCE") or "Web Site"
    _fill_dropdown_label(page, r"prefix|salutation", (job.get("config") or {}).get("SALUTATION") or "Mr.")
    _jr_select_by_label(
        page,
        r"how did you hear|hear about us|source of hire|referral",
        [source, "Careers Site", "Career Site", "Company Website", "Web Site", "Website", "Social Media", "LinkedIn", "Job Board", "Direct Source"],
    )
    _jr_fill_state(page, state)
    _jr_clear_middle_name(page)
    _jr_fill_school(page)
    _jr_clear_invalid_urls(page)
    edu_field = ""
    try:
        edu = json.loads(Path(job["applicantPath"]).read_text()).get("education") or []
        edu_field = (edu[0] or {}).get("field") or ""
    except Exception:
        pass
    _jr_fill_typeahead(
        page,
        r"field of study|major|area of study",
        [edu_field, "Pharmaceutical Engineering", "Pharmaceutical", "Pharmacy", "Other"],
    )
    _jr_dedupe_urls(page)
    _jr_select_by_label(page, r"^gender|^sex$", ["Male"])
    _jr_fill_citizenship(page)
    _jr_select_by_label(
        page,
        r"professional category",
        ["Software", "Engineering", "Information Technology", "IT", "Technology"],
    )
    pronoun = "He/Him"
    _jr_select_by_label(page, r"^pronoun", [pronoun, "He/Him", "He", "Him"])
    _jr_select_by_label(page, r"^declaration", ["Yes", "I agree", "Agree", "I declare", "I acknowledge"])
    _jr_fill_dob(page, job.get("dateOfBirth") or "")


def _jr_scroll_prompt_option(page, name: str) -> bool:
    """Workday country catalogs are virtualized; Search does not filter. Scroll until `name` is in the DOM."""
    listbox = page.locator("[data-automation-id='activeListContainer']")
    if not listbox.count() or not listbox.first.is_visible():
        return False
    box = listbox.first.bounding_box()
    for _ in range(90):
        texts = [t.strip() for t in listbox.locator("[data-automation-id='promptOption']").all_inner_texts()]
        if name in texts:
            return True
        if box:
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + min(box["height"] / 2, 80))
            page.mouse.wheel(0, 360)
        time.sleep(0.12)
    return False


def _jr_click_prompt_option(page, match) -> str:
    """Click a visible catalog option. `match` is a string equality or a compiled regex."""
    return page.evaluate(
        """(want) => {
            const opts = [...document.querySelectorAll("[data-automation-id='activeListContainer'] [data-automation-id='promptOption']")];
            const re = want.startsWith('/') ? new RegExp(want.slice(1, -1), 'i') : null;
            const hit = opts.find(e => {
                const t = (e.innerText || '').trim();
                return re ? re.test(t) : t === want;
            });
            if (!hit) return '';
            hit.click();
            return (hit.innerText || '').trim();
        }""",
        match if isinstance(match, str) else f"/{match.pattern}/",
    )


def _jr_fill_citizenship(page) -> None:
    """JioStar Citizenship Status is a country catalog that nests to Citizen (India)."""
    field = page.locator("[data-automation-id='formField-citizenshipStatus']")
    if not field.count():
        field = _jr_field(page, r"citizenship")
        if not field:
            print("    citizenship: no field")
            return
    shown = field.inner_text()
    if re.search(r"citizen \(india\)", shown, re.I) and "0 items" not in shown.lower():
        print("    citizenship already Citizen (India)")
        return
    _jr_close_menus(page)
    box = field.locator("[data-automation-id='multiselectInputContainer']")
    if box.count():
        box.first.evaluate("el => el.click()")
        time.sleep(0.45)
    else:
        print("    citizenship: no multiselect")
        return
    if not _jr_scroll_prompt_option(page, "India"):
        print("    citizenship: India not in catalog")
        _jr_close_menus(page)
        return
    picked = _jr_click_prompt_option(page, "India")
    print(f"    citizenship → {picked or 'India (no click)'}")
    time.sleep(0.5)
    nested = _jr_click_prompt_option(page, re.compile(r"citizen \(india\)"))
    if not nested:
        nested = _jr_click_prompt_option(page, "Citizen")
    if nested:
        print(f"    citizenship nested → {nested}")
    else:
        sample = page.evaluate(
            """() => [...document.querySelectorAll("[data-automation-id='activeListContainer'] [data-automation-id='promptOption']")].map(e => (e.innerText||'').trim()).slice(0,8)"""
        )
        print(f"    citizenship nested: no match in {sample}")
    _jr_close_menus(page)


def _jr_fill_dob(page, value: str) -> None:
    """JioStar's Date of Birth is DD/MM/YYYY spinbuttons (day box is unique on the wizard)."""
    if not value:
        print("    Date of Birth: no value on file")
        return
    field = _jr_field(page, r"date of birth|birth ?date|^dob$")
    if not field:
        wrappers = page.locator("[data-automation-id='dateInputWrapper']").filter(
            has=page.locator("input[data-automation-id='dateSectionDay-input']")
        )
        field = wrappers.first if wrappers.count() else None
    if not field:
        print("    Date of Birth: no date field")
        return
    if _type_spin_date(field, value):
        print(f"    Date of Birth → {value}")
    else:
        print(f"    Date of Birth: could not type {value}")


def _jr_fill_typeahead(page, label_re: str, values: list[str]) -> None:
    """Workday search+radio widgets (Field of Study): click the labeled input, type, pick a folded match."""
    wanted = [v for v in values if v]
    if not wanted:
        return
    _jr_close_menus(page)
    target = page.evaluate(
        """(src) => {
            const re = new RegExp(src, 'i');
            let found = null;
            for (const lbl of document.querySelectorAll('label')) {
                const t = (lbl.textContent || '').replace(/\\*/g, '').replace(/\\s+/g, ' ').trim();
                if (!re.test(t) || t.length > 80) continue;
                const forId = lbl.getAttribute('for');
                if (forId) {
                    const el = document.getElementById(forId);
                    if (el && el.offsetParent) found = forId;
                }
            }
            return found;
        }""",
        label_re,
    )
    if not target:
        return
    el = page.query_selector(f"#{target}")
    if not el or not el.is_visible():
        return
    try:
        shown = el.input_value()
    except Exception:
        shown = el.inner_text() or ""
    if shown and any(_jr_fold(v) in _jr_fold(shown) for v in wanted if len(v) > 3):
        return
    el.evaluate("e => { e.scrollIntoView({block:'center'}); e.click(); }")
    time.sleep(0.8)
    try:
        el.evaluate("e => { e.focus(); e.value = ''; e.dispatchEvent(new Event('input', {bubbles:true})); }")
    except Exception:
        pass
    page.keyboard.type(wanted[0], delay=40)
    time.sleep(0.6)
    sample = [_jr_option_text(o) for o in _jr_visible_options(page)][:12]
    picked = _jr_click_matching_option(_jr_visible_options(page), wanted)
    if picked:
        print(f"    {label_re} → {picked}")
        _jr_close_menus(page)
        return
    print(f"    {label_re}: no match after typing {wanted[0]!r}; options={sample}")
    for fallback in ("Other", "Not Listed", "Not Applicable"):
        page.keyboard.press("Meta+A")
        page.keyboard.press("Backspace")
        page.keyboard.type(fallback, delay=40)
        time.sleep(0.7)
        picked = _jr_click_matching_option(_jr_visible_options(page), [fallback])
        if picked:
            print(f"    {label_re} → {picked}")
            break
    _jr_close_menus(page)


def _jr_clear_middle_name(page) -> None:
    """Workday rejects [] \" {} in Middle Name; the copilot types N/A or [N/A]. Leave it blank."""
    field = _jr_field(page, r"middle name")
    if not field:
        return
    inp = field.locator("input").first
    if not inp.count():
        return
    try:
        val = inp.input_value()
    except Exception:
        return
    junk = bool(val) and (
        any(c in val for c in "<>[]\"{},\\/")
        or val.strip().upper() in {"N/A", "NA", "NONE", "MIDDLE NAME", "[N/A]"}
    )
    if junk:
        inp.fill("")
        print("    Middle Name → (cleared)")


def _fill_dropdown_label(page, label_re: str, value: str) -> None:
    field = _jr_field(page, label_re)
    if not value or not field:
        return
    btn = field.locator("button").first
    if not btn.count():
        return
    if value.lower() in btn.inner_text().strip().lower():
        return
    btn.click()
    picked = _jr_pick_open_options(page, [value, "Mr.", "Mr"])
    if picked:
        print(f"    {label_re} → {picked}")
    else:
        page.keyboard.press("Escape")


def _fill_screening_questions(page, *args, **kwargs):
    """Prefix/salutation and gender are profile facts, not yes/no screening."""
    _jr_fix_required(page)
    gender = job.get("gender")
    field = page.locator("[data-automation-id^='formField-']").filter(
        has=page.locator("label", has_text=re.compile(r"^\s*gender", re.I))
    )
    if gender and field.count() and field.first.is_visible():
        btn = field.first.locator("button").first
        if btn.inner_text().strip() != gender:
            btn.click()
            # Exact text: a substring match would take "Female" for "Male".
            option = page.locator("[role='option'], [data-automation-id='promptOption']").filter(
                has_text=re.compile(rf"^\s*{re.escape(gender)}\s*$", re.I)
            )
            try:
                option.first.click(timeout=4000)
            except Exception:
                page.keyboard.press("Escape")
            print(f"    Gender → {btn.inner_text().strip()}")
    return _original_screening(page, *args, **kwargs)


filler._fill_screening_questions = _fill_screening_questions


def _education_field(field: str, *_args, **_kwargs) -> str:
    """The copilot rewrites this from the job title (Finance for an SDE role). Use the real degree."""
    return field or "Pharmaceutical Engineering"


filler._education_field = _education_field


def _fill_field_of_study(page, field: str) -> bool:
    """JS-click the typeahead. Playwright's click dies on Workday's prompt overlay."""
    _jr_close_menus(page)
    _jr_fill_typeahead(
        page,
        r"field of study|major|area of study",
        [field, "Pharmaceutical Engineering", "Pharmaceutical", "Pharmacy", "Other"],
    )
    return True


filler._fill_field_of_study = _fill_field_of_study

_orig_edu = filler._fill_education


def _jr_clear_invalid_urls(page) -> None:
    """Workday rejects N/A / No / anything that is not a URL in Facebook and website boxes."""
    cleared = page.evaluate(
        """() => {
            let n = 0;
            for (const i of document.querySelectorAll("input")) {
                if (!i.offsetParent) continue;
                const val = (i.value || "").trim();
                if (!val) continue;
                const box = i.closest("[data-automation-id^='formField']");
                const hint = `${i.type} ${i.getAttribute("aria-label") || ""} ${i.name || ""} ${box ? box.innerText.slice(0, 80) : ""}`.toLowerCase();
                const urlish = i.type === "url" || /facebook|twitter|instagram|linkedin|website|url|http/.test(hint);
                const looksUrl = /^https?:\\/\\//i.test(val) || /^[\\w.-]+\\.[a-z]{2,}\\b/i.test(val);
                if (urlish && !looksUrl) {
                    i.value = "";
                    i.dispatchEvent(new Event("input", { bubbles: true }));
                    i.dispatchEvent(new Event("change", { bubbles: true }));
                    n += 1;
                }
            }
            return n;
        }"""
    )
    if cleared:
        print(f"    Cleared {cleared} invalid URL value(s)")


def _jr_school_score(txt: str) -> int:
    folded = _jr_fold(txt)
    if not folded or "bhubaneswar" in folded:
        return -1
    score = 0
    if "bhu" in folded or "banaras hindu" in folded:
        score += 5
    if "varanasi" in folded or "banaras" in folded:
        score += 5
    if "indian institute of technology" in folded or re.search(r"\biit\b", folded):
        score += 3
    return score


def _jr_click_school_option(opts) -> str:
    scored: list[tuple[int, object, str]] = []
    for opt in opts:
        txt = _jr_option_text(opt)
        score = _jr_school_score(txt)
        if score >= 8:
            scored.append((score, opt, txt))
    if not scored:
        return ""
    scored.sort(key=lambda row: -row[0])
    _opt, txt = scored[0][1], scored[0][2]
    _opt.evaluate("el => { el.scrollIntoView({block:'center'}); el.click(); }")
    time.sleep(0.3)
    return txt


def _jr_wait_options(page, timeout: int = 4000):
    for sel in (
        "[data-automation-id='promptOption']",
        "[data-automation-id='listItem']",
        "[role='option']",
    ):
        try:
            page.wait_for_selector(sel, state="visible", timeout=timeout)
            break
        except Exception:
            continue
    return _jr_visible_options(page)


def _jr_popup_search(page, field):
    """Type into the open prompt's search box, not a leftover input elsewhere on the page."""
    for loc in (
        page.locator("[data-automation-widget='wd-popup']:visible").last,
        page.locator("[role='dialog']:visible").last,
        page.locator("[role='listbox']:visible").last,
        field,
    ):
        if loc.count() == 0:
            continue
        inp = loc.locator("input:visible").first
        try:
            if inp.count() and inp.is_visible():
                return inp
        except Exception:
            continue
    return None


def _jr_click_prompt_label(page, pattern: str) -> str:
    """JS-click a promptOption even when it overlays the search box."""
    return page.evaluate(
        """(src) => {
            const re = new RegExp(src, 'i');
            const hit = [...document.querySelectorAll("[data-automation-id='promptOption']")].find((e) =>
                re.test(e.getAttribute("data-automation-label") || e.innerText || "")
            );
            if (!hit) return "";
            hit.click();
            return (hit.getAttribute("data-automation-label") || hit.innerText || "").trim();
        }""",
        pattern,
    )


def _jr_fill_school(page) -> None:
    """CrowdStrike school is formField-school: type, Enter to search, pick BHU or OTHER."""
    loc = page.locator("[data-automation-id='formField-school'], [data-automation-id='formField-schoolName']")
    if loc.count() == 0:
        return
    field = loc.last
    for i in range(loc.count()):
        text = loc.nth(i).inner_text()
        if re.search(r"0 items selected", text, re.I):
            field = loc.nth(i)
            break
        if re.search(r"\d+ items? selected", text, re.I) and re.search(r"bhu|varanasi|banaras|other", text, re.I):
            print("    school already set")
            return
    shown = field.inner_text()
    if re.search(r"\d+ items? selected", shown, re.I) and "0 items" not in shown.lower() and re.search(
        r"bhu|varanasi|banaras|other", shown, re.I
    ):
        print("    school already set")
        return
    _jr_close_menus(page)
    inp = field.locator("input").first
    if inp.count() == 0:
        print("    school: no input")
        return
    inp.evaluate("el => { el.scrollIntoView({block:'center'}); el.click(); }")
    time.sleep(0.3)
    searches = ["BHU", "Varanasi", "Other"]
    for q in searches:
        try:
            inp.evaluate("el => { el.click(); el.value = ''; el.dispatchEvent(new Event('input', {bubbles:true})); }")
            inp.type(q, delay=30)
        except Exception:
            page.keyboard.type(q, delay=30)
        time.sleep(0.15)
        page.keyboard.press("Enter")
        time.sleep(1.2)
        picked = _jr_click_school_option(_jr_visible_options(page))
        if not picked:
            picked = _jr_click_prompt_label(page, r"other.{0,80}not an available")
        if not picked and q.lower() == "other":
            picked = _jr_click_prompt_label(page, r"^other\b")
        if picked:
            print(f"    school → {picked}")
            _jr_close_menus(page)
            return
        sample = page.evaluate(
            """() => [...document.querySelectorAll("[data-automation-id='activeListContainer'] [data-automation-id='promptOption']")]
                .map(e => (e.getAttribute('data-automation-label') || e.innerText || '').trim()).slice(0, 8)"""
        )
        print(f"    school search {q!r}: {sample}")
    print(f"    school field: {shown[:180]!r}")
    _jr_close_menus(page)


def _fill_education(page, *args, **kwargs):
    try:
        result = _orig_edu(page, *args, **kwargs)
    except Exception as err:
        if "timeout" in str(err).lower() or "click" in str(err).lower():
            print(f"    Education: click timed out; closing menus and continuing")
            _jr_close_menus(page)
            result = None
        else:
            raise
    _jr_fill_school(page)
    _jr_clear_invalid_urls(page)
    return result


filler._fill_education = _fill_education
filler._jr_fill_school = _jr_fill_school
filler._jr_clear_invalid_urls = _jr_clear_invalid_urls

_original_custom = filler._fill_custom_questions
_BLOCK_FIELDS = ["jobTitle", "companyName", "schoolName", "school"]


def _fill_custom_questions(page, *args, **kwargs):
    """The free-text pass would invent a job or school for an empty history block; never let it."""
    empty = page.evaluate(
        """(ids) => ids.some(id => [...document.querySelectorAll(`[data-automation-id='formField-${id}']`)].some(row => {
            const text = row.innerText || '';
            if (/\\d+ items? selected/i.test(text) && !/0 items selected/i.test(text)) return false;
            if (/0 items selected/i.test(text)) return true;
            return [...row.querySelectorAll('input')].some(i => i.offsetParent && !i.value.trim());
        }))""",
        _BLOCK_FIELDS,
    )
    if empty:
        print("    Custom questions: skipped while a work/education block is still empty")
        _jr_clear_invalid_urls(page)
        return
    result = _original_custom(page, *args, **kwargs)
    _jr_clear_middle_name(page)
    _jr_clear_invalid_urls(page)
    return result


filler._fill_custom_questions = _fill_custom_questions

_original_web = filler._fill_websites


def _fill_websites(page, applicant: dict, *args, **kwargs):
    """Don't add portfolio/GitHub a second time — Workday rejects duplicate website URLs."""
    github = (applicant.get("website") or "").strip()
    already = False
    if github:
        already = page.evaluate(
            """(u) => {
                const n = u.replace(/\\/$/, '').replace(/^https?:\\/\\//i, '').toLowerCase();
                return [...document.querySelectorAll('input')].some(i =>
                    (i.value || '').replace(/\\/$/, '').replace(/^https?:\\/\\//i, '').toLowerCase() === n
                    || (i.value || '').toLowerCase().includes(n)
                );
            }""",
            github,
        )
    patched = dict(applicant)
    if already:
        patched["website"] = ""
        print("    Website already on the form — not adding a duplicate")
    return _original_web(page, patched, *args, **kwargs)


filler._fill_websites = _fill_websites


def _jr_dedupe_urls(page) -> None:
    page.evaluate(
        """() => {
            const inputs = [...document.querySelectorAll("input[type='url'], input[data-automation-id*='website' i], input[data-automation-id*='url' i], input[type='text']")]
                .filter(i => i.offsetParent && /https?:\\/\\//i.test(i.value || ''));
            const seen = new Set();
            for (const i of inputs) {
                const v = (i.value || '').replace(/\\/$/, '').toLowerCase();
                if (seen.has(v)) {
                    i.value = '';
                    i.dispatchEvent(new Event('input', { bubbles: true }));
                    i.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    seen.add(v);
                }
            }
        }"""
    )


# ---------- Attach to the apply Chrome ----------

pages: list = []
real_sync_playwright = filler.sync_playwright


class _AttachedBrowser:
    def __init__(self, browser):
        self._browser = browser

    def new_page(self):
        ctx = self._browser.contexts[0]
        want = re.search(r"_(JR\d+)", job.get("url") or "", re.I)
        want = want.group(1).upper() if want else ""
        ranked: list[tuple[int, object]] = []
        for page in ctx.pages:
            try:
                url = (page.url or "").lower()
                if "myworkdayjobs.com" not in url and "myworkdaysite.com" not in url:
                    continue
                same = bool(want and want.lower() in url)
                wizard = _jr_on_wizard(page)
                stacked = url.count("applymanually")
                if same and wizard:
                    ranked.append((stacked, page))
                elif same and "/apply" in url:
                    ranked.append((10 + stacked, page))
                elif same:
                    ranked.append((20 + stacked, page))
            except Exception:
                pass
        if ranked:
            ranked.sort(key=lambda row: row[0])
            page = ranked[0][1]
            pages.append(page)
            print(f"  Reusing Workday tab: {page.url}")
            return page
        page = ctx.new_page()
        pages.append(page)
        return page

    def close(self):
        """The apply Chrome belongs to the runner; leave it and the tab open."""


class _Chromium:
    def __init__(self, p):
        self._p = p

    def launch(self, **_):
        return _AttachedBrowser(self._p.chromium.connect_over_cdp(job["cdpUrl"]))


class _Playwright:
    def __enter__(self):
        self._cm = real_sync_playwright()
        self.chromium = _Chromium(self._cm.__enter__())
        return self

    def __exit__(self, *exc):
        return self._cm.__exit__(*exc)


filler.sync_playwright = _Playwright

# ---------- Sign-in with the stored tenant password (never input()) ----------

retries = {"left": 2}
FORM_SEL = "[data-automation-id='progressBar']"
EMAIL_SEL = "input[data-automation-id='email']"
PASSWORD_SEL = "input[data-automation-id='password'], input[type='password']"
SIGNIN_BTN = "[data-automation-id='signInSubmitButton']"
CREATE_BTN = "[data-automation-id='createAccountSubmitButton']"


def _visible(page, selector: str):
    el = page.query_selector(selector)
    return el if el and el.is_visible() else None


def _wd_fill(page, selector: str, value: str) -> bool:
    el = _visible(page, selector)
    if not el:
        return False
    el.click()
    time.sleep(0.2)
    el.fill(value)
    return True


def _wd_click(page, selector: str) -> bool:
    el = _visible(page, selector)
    if not el:
        return False
    parent = el.evaluate_handle("el => el.parentElement")
    overlay = parent.query_selector("[data-automation-id='click_filter']") if parent else None
    (overlay or el).evaluate("el => { el.scrollIntoView({block:'center'}); el.click(); }")
    return True


def _wait_for_form() -> bool:
    """Signed-in Workday sometimes passes through /apply before the wizard renders."""
    if not pages:
        return False
    page = pages[-1]
    if _jr_on_wizard(page):
        return True
    for attempt in range(2):
        try:
            page.wait_for_selector(FORM_SEL, state="visible", timeout=25000)
            return True
        except Exception:
            if attempt == 0 and not _jr_on_wizard(page):
                _jr_goto(page, job.get("url") or page.url)
    return _jr_on_wizard(page)


def _jr_is_on_signin_page(page) -> bool:
    if _jr_on_wizard(page):
        return False
    if _visible(page, SIGNIN_BTN) or _visible(page, CREATE_BTN):
        return True
    if _visible(page, EMAIL_SEL) and not _visible(page, FORM_SEL):
        return True
    return filler._orig_is_on_signin_page(page) if hasattr(filler, "_orig_is_on_signin_page") else False


def _jr_auto_fill_signin(page, email: str, password: str) -> bool:
    if _jr_on_wizard(page) or _visible(page, FORM_SEL):
        return True
    if not _wd_fill(page, EMAIL_SEL, email):
        for sel in (
            "input[type='email']",
            "input[name='email']",
            "input[autocomplete='email']",
            "input[id*='email' i]",
        ):
            if _wd_fill(page, sel, email):
                break
    pws = [el for el in page.query_selector_all(PASSWORD_SEL) if el.is_visible()]
    if not pws:
        print("  Auto sign-in: no password field found.")
        return False
    pws[0].click()
    time.sleep(0.2)
    pws[0].fill(password)
    if len(pws) > 1:
        pws[1].click()
        time.sleep(0.2)
        pws[1].fill(password)
        return _wd_click(page, CREATE_BTN) or _wd_click(page, SIGNIN_BTN)
    return _wd_click(page, SIGNIN_BTN) or _wd_click(page, CREATE_BTN)


def _jr_handle_gmail_login(page, gmail: str):
    """Fill Workday's automation-id email/password boxes with the stored tenant password."""
    password = job["password"]
    deadline = time.time() + 10
    while time.time() < deadline:
        if _visible(page, EMAIL_SEL) or _visible(page, "input[type='email']") or _visible(page, PASSWORD_SEL):
            break
        time.sleep(0.3)
    if not _jr_auto_fill_signin(page, gmail, password):
        if not _visible(page, FORM_SEL):
            raise Park("Workday sign-in did not reach the application form")
        return password
    try:
        page.wait_for_load_state("domcontentloaded", timeout=12000)
    except Exception:
        pass
    time.sleep(2.0)
    _jr_wait_for_form_or_auto_signin(page, gmail, password)
    return password


def _jr_wait_for_form_or_auto_signin(page, email: str, password: str | None, timeout: int = 45) -> None:
    deadline = time.time() + timeout
    attempted = False
    while time.time() < deadline:
        if _visible(page, FORM_SEL):
            return
        if password and not attempted and _jr_is_on_signin_page(page):
            pws = [el for el in page.query_selector_all(PASSWORD_SEL) if el.is_visible()]
            if not pws and not _visible(page, EMAIL_SEL):
                time.sleep(1.0)
                continue
            if _jr_auto_fill_signin(page, email, password):
                attempted = True
                try:
                    page.wait_for_load_state("domcontentloaded", timeout=12000)
                except Exception:
                    pass
                time.sleep(2.0)
                attempted = False
        time.sleep(1.0)
    raise Park("Workday sign-in did not reach the application form")


filler._orig_is_on_signin_page = filler._is_on_signin_page
filler._is_on_signin_page = _jr_is_on_signin_page
filler._auto_fill_signin = _jr_auto_fill_signin
filler._handle_gmail_login = _jr_handle_gmail_login
filler._wait_for_form_or_auto_signin = _jr_wait_for_form_or_auto_signin

_orig_auto_apply = filler._auto_apply_and_login


def _jr_auto_apply_and_login(page, gmail=None):
    """TS already reached the wizard. Never rebuild applyManually onto the live URL."""
    if gmail is None:
        gmail = filler.WORKDAY_EMAIL
    if _jr_on_wizard(page):
        print("  Workday wizard already open — skipping copilot navigation")
        return
    _jr_goto(page, job.get("url") or page.url)
    if _jr_on_wizard(page):
        return
    if _jr_is_on_signin_page(page):
        _jr_auto_fill_signin(page, gmail, job["password"])
        _wait_for_form()
        return
    # Copilot rebuilds applyManually onto the live path; stay put when already on /apply/.
    if "/apply/" in (page.url or "").lower():
        _wait_for_form()
        return
    return _orig_auto_apply(page, gmail)


filler._auto_apply_and_login = _jr_auto_apply_and_login


def _input(prompt: str = "") -> str:
    print(prompt, flush=True)
    p = prompt.lower()
    if "password" in p:
        return job["password"]
    if "signed in" in p or "first page" in p or "first form page" in p or "complete sign-in" in p:
        if pages and _jr_is_on_signin_page(pages[-1]):
            _jr_auto_fill_signin(pages[-1], job.get("email") or job.get("config", {}).get("WORKDAY_EMAIL", ""), job["password"])
        if _wait_for_form():
            return ""
        raise Park("Workday sign-in did not reach the application form")
    if "submit" in p:
        if job["dryRun"]:
            raise Park("dry_run")
        return ""
    if "press enter when ready" in p:
        err = _jr_error_text(pages[-1]) if pages else ""
        raise Park(f"Workday would not leave this step. {err}".strip())
    if "moved to the next page" in p:
        start = _jr_page_key(pages[-1]) if pages else ""
        deadline = time.time() + 60
        while time.time() < deadline:
            time.sleep(2)
            for page in pages:
                try:
                    if _jr_page_key(page) != start:
                        return ""
                except Exception:
                    pass
        raise Park("Workday did not reach the next form step")
    raise Park(prompt.strip() or "The filler asked for help")


builtins.input = _input

# ---------- Run ----------

CONFIRMED_RE = re.compile(
    r"application (has been |was )?(successfully )?submitted|thank you for (applying|your application)|"
    r"we have received your application|successfully applied|you have successfully (applied|submitted)|"
    r"application complete",
    re.I,
)


def _confirm_pages():
    seen = list(pages)
    for page in list(pages):
        try:
            for extra in page.context.pages:
                if extra not in seen:
                    seen.append(extra)
        except Exception:
            pass
    return seen


def confirmed() -> bool:
    """Workday often opens /jobTasks/completed/application in a new tab the filler did not track."""
    for _ in range(15):
        for page in _confirm_pages():
            try:
                url = (page.url or "").lower()
                if "/jobtasks/completed" in url or "/completed/application" in url:
                    return True
                if CONFIRMED_RE.search(page.inner_text("body")):
                    return True
            except Exception:
                pass
        time.sleep(1.5)
    return False


try:
    filler.fill_application(
        job["url"],
        job_title=job["jobTitle"],
        job_desc=job["jobDescription"],
        resume_pdf=job["resumePath"],
        company=job["company"],
    )
except Park as e:
    if str(e) == "dry_run":
        result("ready", "Filled every Workday page; stopped before Submit (dry run)")
    else:
        result("parked", str(e)[:300])
    sys.exit(0)
except Exception as e:  # noqa: BLE001
    result("parked", f"Workday filler error: {e}"[:300])
    sys.exit(0)

if confirmed():
    for page in pages:
        try:
            page.close()
        except Exception:
            pass
    result("submitted")
else:
    result("unconfirmed", "Clicked Submit but Workday showed no confirmation")
