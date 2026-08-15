// ═══════════════ 发布/调试 控制 ═══════════════
// #define RELEASE_BUILD    // DEV MODE
// ═══════════════════════════════════════════════

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <oleacc.h>
#include "resource.h"
#include <wincodec.h>
#include <gdiplus.h>
#pragma comment(lib, "gdiplus.lib")
#include <winhttp.h>
#include <bcrypt.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <objbase.h>
#include <dwmapi.h>
#include <commctrl.h>
#pragma comment(lib, "comctl32.lib")

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <iomanip>
#include <filesystem>
#include <fstream>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "../sdk/JadeView.h"

#pragma comment(lib, "dwmapi.lib")

extern "C" {
int32_t JADEVIEW_CALL JadeView_init(int32_t enable_devmod, const char* log_path, const char* data_directory, const char* app_name, const char* app_signature, int32_t single_instance);
int32_t JADEVIEW_CALL run_message_loop(void);
int32_t JADEVIEW_CALL jadeview_exit(void);
int32_t JADEVIEW_CALL JadeView_unload(void);
uint32_t JADEVIEW_CALL create_webview_window(const char* url, uint32_t parent_window_id, const struct WebViewWindowOptions* options, const struct WebViewSettings* webview_settings);
uint32_t JADEVIEW_CALL create_borderless_webview_window(const char* url, const struct WebViewSettings* webview_settings);
size_t JADEVIEW_CALL get_window_hwnd(uint32_t window_id);
int32_t JADEVIEW_CALL register_ipc_handler(const char* channel, IpcCallback ipc_cb);
int32_t JADEVIEW_CALL set_protocol_service_path(const char* root_path, char* url_buffer, size_t buffer_size, int32_t hot_reload);
int32_t JADEVIEW_CALL set_window_theme(uint32_t window_id, const char* theme);
int32_t JADEVIEW_CALL set_window_title(uint32_t window_id, const char* title);
int32_t JADEVIEW_CALL set_window_size(uint32_t window_id, int32_t width, int32_t height);
int32_t JADEVIEW_CALL set_window_position(uint32_t window_id, int32_t x, int32_t y);
int32_t JADEVIEW_CALL set_window_visible(uint32_t window_id, int32_t visible);
int32_t JADEVIEW_CALL set_window_focus(uint32_t window_id);
int32_t JADEVIEW_CALL minimize_window(uint32_t window_id);
int32_t JADEVIEW_CALL toggle_maximize_window(uint32_t window_id);
int32_t JADEVIEW_CALL close_window(uint32_t window_id);
int32_t JADEVIEW_CALL open_devtools(uint32_t window_id);
int32_t JADEVIEW_CALL close_devtools(uint32_t window_id);
int32_t JADEVIEW_CALL is_devtools_open(uint32_t window_id);
int32_t JADEVIEW_CALL set_window_backdrop(uint32_t window_id, const char* backdrop_type);
int32_t JADEVIEW_CALL set_window_background_color(uint32_t window_id, const char* background_color_hex);
int32_t JADEVIEW_CALL smart_convert_encoding(const uint8_t* input_data, int32_t input_len, const char* target_encoding, char* output_buffer, int32_t buffer_size, char* detected_encoding, int32_t detected_encoding_size);
uint32_t JADEVIEW_CALL jade_on(const char* event_name, IpcCallback callback);
char* JADEVIEW_CALL jade_text_create(const char* text);
}

namespace {
uint32_t g_main_window = 0;
bool g_devMode = false;
bool g_window_shown = false;
int g_webview_load_count = 0;
bool g_debugMode = false;
std::atomic_bool g_shutdownRequested{false};
std::filesystem::path g_log_file;
std::filesystem::path g_test_log_file;
std::string g_index_url;
std::set<std::string> g_fonts;
std::atomic<unsigned long long> g_lastCpuIdle{0};
std::atomic<unsigned long long> g_lastCpuKernel{0};
std::atomic<unsigned long long> g_lastCpuUser{0};

void Log(const std::string& message) {
  if (g_log_file.empty()) return;
  std::ofstream out(g_log_file, std::ios::app | std::ios::binary);
  if (!out) return;
  SYSTEMTIME st = {};
  GetLocalTime(&st);
  char prefix[64] = {};
  sprintf_s(prefix, "[%04u-%02u-%02u %02u:%02u:%02u.%03u] ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
  out << prefix << message << "\r\n";
}

// DbgLog — 始终可用（发布版也写入 startup.log）
void DbgLog(const std::string& msg, bool isError = false) {
  if (!g_debugMode) return;
  SYSTEMTIME st = {}; GetLocalTime(&st);
  char ts[64] = {};
  sprintf_s(ts, "%02u:%02u:%02u.%03u", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
  const char* tag = isError ? "[*]" : "[✓]";
  Log(std::string(tag) + " " + msg);
}

void RequestAppExit(const std::string& reason) {
  if (g_shutdownRequested.exchange(true)) {
    Log("shutdown already requested, ignored: " + reason);
    return;
  }

  Log("shutdown requested: " + reason);
  std::thread([reason]() {
    Sleep(50);
    uint32_t window = g_main_window;
    if (window) {
      Log("shutdown: close_window id=" + std::to_string(window));
      close_window(window);
    }
    Log("shutdown: jadeview_exit");
    jadeview_exit();
  }).detach();
}

// 与前端 CSS 的 .app border-radius 保持一致（CSS px，会按 DPI 缩放成物理像素）。
static const int kWindowCornerRadiusCss = 12;

void ApplyWindowRoundedCorners(HWND hwnd) {
  if (!hwnd) return;

  // Windows 11 原生圆角偏好（Win10 上是空操作，但留着对 Win11 友好）。
  enum DWMWINDOWATTRIBUTE_LOCAL {
    DWMWA_WINDOW_CORNER_PREFERENCE_LOCAL = 33,
    DWMWA_BORDER_COLOR_LOCAL = 34
  };
  enum DWM_WINDOW_CORNER_PREFERENCE_LOCAL {
    DWMWCP_DEFAULT_LOCAL = 0,
    DWMWCP_DONOTROUND_LOCAL = 1,
    DWMWCP_ROUND_LOCAL = 2,
    DWMWCP_ROUNDSMALL_LOCAL = 3
  };
  int preference = DWMWCP_ROUND_LOCAL;
  DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE_LOCAL, &preference, sizeof(preference));
  COLORREF noBorder = 0xFFFFFFFE;
  DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR_LOCAL, &noBorder, sizeof(noBorder));

  // 最大化时铺满工作区，必须方角无区域，否则四角会缺口。
  if (IsZoomed(hwnd)) { SetWindowRgn(hwnd, nullptr, TRUE); Log("round: zoomed -> null rgn"); return; }

  RECT wr;
  if (!GetWindowRect(hwnd, &wr)) return;
  int W = wr.right - wr.left, H = wr.bottom - wr.top;
  if (W <= 0 || H <= 0) return;

  // ★ Win10 的 WS_THICKFRAME 窗口四周有 ~7-8px 不可见拉伸边框，GetWindowRect 含之；
  //   SetWindowRgn 坐标相对窗口矩形，必须把区域内缩到"可见边界"(DWM 扩展帧边界)，
  //   否则圆角落在不可见边里、可见角仍是方的。
  int lx = 0, ty = 0, rx = 0, by = 0;
  RECT fb{};
  // DWMWA_EXTENDED_FRAME_BOUNDS = 9
  if (SUCCEEDED(DwmGetWindowAttribute(hwnd, 9, &fb, sizeof(fb)))) {
    lx = fb.left - wr.left;     // 左侧不可见边宽
    ty = fb.top - wr.top;       // 顶部(通常 0)
    rx = wr.right - fb.right;    // 右侧
    by = wr.bottom - fb.bottom;  // 底部
    if (lx < 0) lx = 0; if (ty < 0) ty = 0; if (rx < 0) rx = 0; if (by < 0) by = 0;
  }

  // DPI 缩放半径，与 CSS px 对齐（GetDpiForWindow: Win10 1607+，动态取避免老系统缺符号）。
  UINT dpi = 96;
  if (HMODULE u32 = GetModuleHandleW(L"user32.dll")) {
    typedef UINT(WINAPI* GetDpiForWindowFn)(HWND);
    if (auto p = (GetDpiForWindowFn)GetProcAddress(u32, "GetDpiForWindow")) {
      UINT d = p(hwnd); if (d) dpi = d;
    }
  }
  int radius = MulDiv(kWindowCornerRadiusCss, (int)dpi, 96);
  int dia = radius * 2;
  // 区域 = 可见边界(内缩不可见边框)，末两参是圆角椭圆全尺寸(=2*半径)；右/下 +1 补边界。
  HRGN rgn = CreateRoundRectRgn(lx, ty, W - rx + 1, H - by + 1, dia, dia);
  int ret = SetWindowRgn(hwnd, rgn, TRUE);  // 窗口接管 rgn 所有权
  Log("round: Win=" + std::to_string(W) + "x" + std::to_string(H) +
         " inset L" + std::to_string(lx) + " T" + std::to_string(ty) +
         " R" + std::to_string(rx) + " B" + std::to_string(by) +
         " dpi=" + std::to_string(dpi) + " r=" + std::to_string(radius) +
         " SetWindowRgn=" + std::to_string(ret));
}

// 子类化主窗：尺寸/位置/DPI 变化时重算圆角区域，使窗口本体(及 DWM 阴影)始终为圆角，
// 根治"内容圆角但方形窗口/阴影直角在四角露出淡线"的残留。
LRESULT CALLBACK MainWindowSubclassProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam,
                                        UINT_PTR, DWORD_PTR) {
  switch (msg) {
    case WM_SIZE:
    case WM_WINDOWPOSCHANGED:
    case WM_DPICHANGED: {
      LRESULT r = DefSubclassProc(hwnd, msg, wParam, lParam);
      ApplyWindowRoundedCorners(hwnd);
      return r;
    }
    default:
      return DefSubclassProc(hwnd, msg, wParam, lParam);
  }
}

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) return std::string();
  int size = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string result(size > 0 ? size - 1 : 0, '\0');
  if (size > 1) {
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, result.data(), size, nullptr, nullptr);
  }
  return result;
}

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return std::wstring();
  int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
  std::wstring result(size > 0 ? size - 1 : 0, L'\0');
  if (size > 1) MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, result.data(), size);
  return result;
}

std::string UrlEncodePath(const std::string& value) {
  static const char hex[] = "0123456789ABCDEF";
  std::string out;
  for (unsigned char ch : value) {
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == ':' || ch == '/' || ch == '-' || ch == '_' || ch == '.') {
      out.push_back(static_cast<char>(ch));
    } else if (ch == '\\') {
      out.push_back('/');
    } else {
      out.push_back('%');
      out.push_back(hex[ch >> 4]);
      out.push_back(hex[ch & 0x0F]);
    }
  }
  return out;
}

std::string FileUrl(const std::filesystem::path& path) {
  return "file:///" + UrlEncodePath(WideToUtf8(path.wstring()));
}

bool IsNumericFilename(const std::filesystem::path& path) {
  auto name = path.filename().wstring();
  return !name.empty() && std::all_of(name.begin(), name.end(), [](wchar_t ch) {
    return ch >= L'0' && ch <= L'9';
  });
}

void CleanNumericTempFiles(const std::filesystem::path& dir, const char* phase) {
  if (!std::filesystem::exists(dir)) return;
  std::error_code itEc;
  for (auto& entry : std::filesystem::directory_iterator(dir, itEc)) {
    if (!entry.is_regular_file()) continue;
    if (!IsNumericFilename(entry.path())) continue;

    const auto pathText = WideToUtf8(entry.path().wstring());
    std::error_code sizeEc;
    auto size = std::filesystem::file_size(entry.path(), sizeEc);
    std::error_code ec;
    std::filesystem::remove(entry.path(), ec);
    if (ec) {
      Sleep(200);
      std::filesystem::remove(entry.path(), ec);
    }
    if (ec) {
      Log(std::string("cleanup numeric temp failed phase=") + phase + " path=" + pathText + " error=" + ec.message());
    } else {
      Log(std::string("cleanup numeric temp removed phase=") + phase + " path=" + pathText + " size=" + (sizeEc ? "unknown" : std::to_string(static_cast<unsigned long long>(size))));
    }
  }
  if (itEc) Log(std::string("cleanup numeric temp iterate failed phase=") + phase + " dir=" + WideToUtf8(dir.wstring()) + " error=" + itEc.message());
}

std::filesystem::path ExeDir() {
  wchar_t buffer[MAX_PATH] = {};
  GetModuleFileNameW(nullptr, buffer, MAX_PATH);
  return std::filesystem::path(buffer).parent_path();
}

// 探测目录是否可写：能创建并写入一个探针文件即视为可写。
// 用于支持从只读 U 盘 / 受保护目录（Program Files）运行。
bool IsDirWritable(const std::filesystem::path& dir) {
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  auto probe = dir / L".jade_write_test.tmp";
  {
    std::ofstream f(probe, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f << 'x';
    if (!f.good()) return false;
  }
  std::error_code rec;
  std::filesystem::remove(probe, rec);
  return true;
}

std::filesystem::path LocalAppDataDir() {
  wchar_t buf[MAX_PATH] = {};
  DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH);
  if (n > 0 && n < MAX_PATH) return std::filesystem::path(buf);
  return std::filesystem::path();
}

std::string JsonStringValue(const std::string& json, const std::string& key) {
  const std::string marker = "\"" + key + "\"";
  size_t pos = json.find(marker);
  if (pos == std::string::npos) return std::string();
  pos = json.find(':', pos + marker.size());
  if (pos == std::string::npos) return std::string();
  pos = json.find('"', pos + 1);
  if (pos == std::string::npos) return std::string();

  std::string out;
  bool esc = false;
  for (size_t i = pos + 1; i < json.size(); ++i) {
    char c = json[i];
    if (esc) {
      switch (c) {
      case 'n': out.push_back('\n'); break;
      case 'r': out.push_back('\r'); break;
      case 't': out.push_back('\t'); break;
      case '"': out.push_back('"'); break;
      case '\\': out.push_back('\\'); break;
      default: out.push_back(c); break;
      }
      esc = false;
      continue;
    }
    if (c == '\\') {
      esc = true;
      continue;
    }
    if (c == '"') break;
    out.push_back(c);
  }
  return out;
}

std::string JsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 16);
  for (unsigned char ch : value) {
    switch (ch) {
    case '"': out += "\\\""; break;
    case '\\': out += "\\\\"; break;
    case '\n': out += "\\n"; break;
    case '\r': out += "\\r"; break;
    case '\t': out += "\\t"; break;
    default:
      if (ch < 0x20) out += ' ';
      else out.push_back(static_cast<char>(ch));
      break;
    }
  }
  return out;
}

std::string BytesToHex(const UCHAR* data, DWORD size) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (DWORD i = 0; i < size; ++i) {
    out.push_back(digits[(data[i] >> 4) & 0x0F]);
    out.push_back(digits[data[i] & 0x0F]);
  }
  return out;
}

std::string HashTextSha(const std::string& algorithm, const std::string& text) {
  LPCWSTR alg = nullptr;
  if (algorithm == "SHA-1") alg = BCRYPT_SHA1_ALGORITHM;
  else if (algorithm == "SHA-256") alg = BCRYPT_SHA256_ALGORITHM;
  else if (algorithm == "SHA-384") alg = BCRYPT_SHA384_ALGORITHM;
  else if (algorithm == "SHA-512") alg = BCRYPT_SHA512_ALGORITHM;
  else return "";

  BCRYPT_ALG_HANDLE alg_handle = nullptr;
  BCRYPT_HASH_HANDLE hash_handle = nullptr;
  DWORD object_size = 0, hash_size = 0, cb_data = 0;
  std::vector<UCHAR> object_buffer;
  std::vector<UCHAR> hash_buffer;

  if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&alg_handle, alg, nullptr, 0))) return "";
  auto cleanup = [&]() {
    if (hash_handle) BCryptDestroyHash(hash_handle);
    if (alg_handle) BCryptCloseAlgorithmProvider(alg_handle, 0);
  };
  if (!BCRYPT_SUCCESS(BCryptGetProperty(alg_handle, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_size), sizeof(object_size), &cb_data, 0))) { cleanup(); return ""; }
  if (!BCRYPT_SUCCESS(BCryptGetProperty(alg_handle, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_size), sizeof(hash_size), &cb_data, 0))) { cleanup(); return ""; }
  object_buffer.resize(object_size);
  hash_buffer.resize(hash_size);
  if (!BCRYPT_SUCCESS(BCryptCreateHash(alg_handle, &hash_handle, object_buffer.data(), object_size, nullptr, 0, 0))) { cleanup(); return ""; }
  if (!BCRYPT_SUCCESS(BCryptHashData(hash_handle, reinterpret_cast<PUCHAR>(const_cast<char*>(text.data())), static_cast<ULONG>(text.size()), 0))) { cleanup(); return ""; }
  if (!BCRYPT_SUCCESS(BCryptFinishHash(hash_handle, hash_buffer.data(), hash_size, 0))) { cleanup(); return ""; }
  std::string out = BytesToHex(hash_buffer.data(), hash_size);
  cleanup();
  return out;
}

std::string WideBstrToUtf8(BSTR value) {
  if (!value) return std::string();
  std::wstring wide(value, SysStringLen(value));
  return WideToUtf8(wide);
}

std::string VariantToString(VARIANT& value) {
  VARIANT dest;
  VariantInit(&dest);
  if (SUCCEEDED(VariantChangeType(&dest, &value, 0, VT_BSTR))) {
    std::string text = WideBstrToUtf8(dest.bstrVal);
    VariantClear(&dest);
    return text;
  }
  return std::string();
}

std::string MsaaRoleToText(LONG role) {
  wchar_t buffer[256] = {};
  UINT len = GetRoleTextW(static_cast<DWORD>(role), buffer, 256);
  if (len > 0) return WideToUtf8(std::wstring(buffer, len));
  return std::to_string(role);
}

std::string MsaaStateToText(LONG state) {
  wchar_t buffer[512] = {};
  UINT len = GetStateTextW(static_cast<DWORD>(state), buffer, 512);
  if (len > 0) return WideToUtf8(std::wstring(buffer, len));
  return std::to_string(state);
}

uintptr_t ParseInteger(const std::string& text) {
  try {
    size_t idx = 0;
    int base = 10;
    if (text.rfind("0x", 0) == 0 || text.rfind("0X", 0) == 0) base = 16;
    else if (text.find_first_of("abcdefABCDEF") != std::string::npos) base = 16;
    return static_cast<uintptr_t>(std::stoull(text, &idx, base));
  } catch (...) {
    return 0;
  }
}

HWND ParseHwnd(const std::string& text) {
  return reinterpret_cast<HWND>(ParseInteger(text));
}

constexpr int MSAA_MAX_NODES = 5000;
constexpr int MSAA_MAX_DEPTH = 32;

std::string MsaaLimitNodeJson(const char* reason) {
  return std::string("{\"name\":\"(") + reason + ")\",\"value\":\"\",\"description\":\"\",\"role\":\"limit\",\"state\":\"truncated\",\"help\":\"\",\"shortcut\":\"\",\"defaultAction\":\"\",\"childCount\":0,\"children\":[]}";
}

struct MsaaTreeBuildResult {
  bool ok = false;
  std::string treeJson;
  int nodeCount = 0;
  bool truncated = false;
  long rootChildCount = 0;
};

std::string MsaaNodeJson(IAccessible* acc, VARIANT child, int depth, int& count, int maxNodes, int maxDepth, bool& truncated);

MsaaTreeBuildResult BuildMsaaTree(IAccessible* acc) {
  MsaaTreeBuildResult result;
  if (!acc) return result;
  VARIANT self; VariantInit(&self); self.vt = VT_I4; self.lVal = CHILDID_SELF;
  acc->get_accChildCount(&result.rootChildCount);
  result.treeJson = MsaaNodeJson(acc, self, 0, result.nodeCount, MSAA_MAX_NODES, MSAA_MAX_DEPTH, result.truncated);
  result.ok = !result.treeJson.empty() && result.treeJson != "{}";
  return result;
}

std::string MsaaNodeJson(IAccessible* acc, VARIANT child, int depth, int& count, int maxNodes, int maxDepth, bool& truncated) {
  if (!acc) return "{}";
  if (count >= maxNodes) {
    truncated = true;
    return MsaaLimitNodeJson("node limit reached");
  }
  if (depth > maxDepth) {
    truncated = true;
    return MsaaLimitNodeJson("depth limit reached");
  }
  ++count;
  BSTR name = nullptr, value = nullptr, desc = nullptr, help = nullptr, shortcut = nullptr, defAction = nullptr;
  VARIANT role, state;
  VariantInit(&role); VariantInit(&state);
  long child_count = 0;
  acc->get_accName(child, &name);
  acc->get_accValue(child, &value);
  acc->get_accDescription(child, &desc);
  acc->get_accRole(child, &role);
  acc->get_accState(child, &state);
  acc->get_accHelp(child, &help);
  acc->get_accKeyboardShortcut(child, &shortcut);
  acc->get_accDefaultAction(child, &defAction);
  if (child.vt == VT_I4 && child.lVal == CHILDID_SELF) acc->get_accChildCount(&child_count);
  LONG role_num = role.vt == VT_I4 ? role.lVal : 0;
  LONG state_num = state.vt == VT_I4 ? state.lVal : 0;
  // Get rect and hwnd
  RECT rc = {}; HWND hwndNode = nullptr;
  if (SUCCEEDED(acc->accLocation(&rc.left, &rc.top, &rc.right, &rc.bottom, child))) {
    LONG w = rc.right, h = rc.bottom;
    WindowFromAccessibleObject(acc, &hwndNode);
    rc.right = rc.left + w; rc.bottom = rc.top + h;
  }
  std::string json = "{";
  json += "\"name\":\"" + JsonEscape(WideBstrToUtf8(name)) + "\",";
  json += "\"value\":\"" + JsonEscape(WideBstrToUtf8(value)) + "\",";
  json += "\"description\":\"" + JsonEscape(WideBstrToUtf8(desc)) + "\",";
  json += "\"role\":\"" + JsonEscape(MsaaRoleToText(role_num)) + "\",";
  json += "\"state\":\"" + JsonEscape(MsaaStateToText(state_num)) + "\",";
  json += "\"help\":\"" + JsonEscape(WideBstrToUtf8(help)) + "\",";
  json += "\"shortcut\":\"" + JsonEscape(WideBstrToUtf8(shortcut)) + "\",";
  json += "\"defaultAction\":\"" + JsonEscape(WideBstrToUtf8(defAction)) + "\",";
  if (hwndNode) { char hwbuf[32]={}; sprintf_s(hwbuf,"0x%p",hwndNode); json += "\"hwnd\":\"" + std::string(hwbuf) + "\","; }
  if (rc.right > rc.left || rc.bottom > rc.top) json += "\"rect\":{\"left\":" + std::to_string(rc.left) + ",\"top\":" + std::to_string(rc.top) + ",\"right\":" + std::to_string(rc.right) + ",\"bottom\":" + std::to_string(rc.bottom) + "},";
  json += "\"childCount\":" + std::to_string(child_count) + ",\"children\":[";
  if (child.vt == VT_I4 && child.lVal == CHILDID_SELF && child_count > 0 && count < maxNodes) {
    long request_count = child_count;
    int remaining = maxNodes - count;
    if (remaining < request_count) {
      request_count = remaining;
      truncated = true;
    }
    std::vector<VARIANT> children(request_count);
    long obtained = 0;
    if (SUCCEEDED(AccessibleChildren(acc, 0, request_count, children.data(), &obtained))) {
      bool first = true;
      for (long i = 0; i < obtained && count < maxNodes; ++i) {
        if (!first) json += ",";
        first = false;
        if (children[i].vt == VT_DISPATCH && children[i].pdispVal) {
          IAccessible* childAcc = nullptr;
          if (SUCCEEDED(children[i].pdispVal->QueryInterface(IID_IAccessible, reinterpret_cast<void**>(&childAcc))) && childAcc) {
            VARIANT self; VariantInit(&self); self.vt = VT_I4; self.lVal = CHILDID_SELF;
            json += MsaaNodeJson(childAcc, self, depth + 1, count, maxNodes, maxDepth, truncated);
            childAcc->Release();
          } else json += "{}";
        } else if (children[i].vt == VT_I4) {
          json += MsaaNodeJson(acc, children[i], depth + 1, count, maxNodes, maxDepth, truncated);
        } else json += "{}";
        VariantClear(&children[i]);
      }
      if (obtained < child_count || count >= maxNodes) truncated = true;
    }
  } else if (child.vt == VT_I4 && child.lVal == CHILDID_SELF && child_count > 0 && count >= maxNodes) {
    truncated = true;
  }
  json += "]}";
  if (name) SysFreeString(name); if (value) SysFreeString(value); if (desc) SysFreeString(desc); if (help) SysFreeString(help); if (shortcut) SysFreeString(shortcut); if (defAction) SysFreeString(defAction);
  VariantClear(&role); VariantClear(&state);
  return json;
}

const char* JADEVIEW_CALL ConvertEncoding(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string input = JsonStringValue(json, "input");
  std::string target = JsonStringValue(json, "target");
  DbgLog(std::string("IPC:convert_encoding target=") + target + " input_len=" + std::to_string(input.size()));
  if (target.empty()) target = "utf-8";

  // Map encoding name to Windows code page
  static const struct { const char* name; UINT cp; } CpMap[] = {
    {"utf-8", CP_UTF8}, {"utf8", CP_UTF8},
    {"gbk", 936}, {"gb2312", 936},
    {"gb18030", 54936},
    {"big5", 950},
    {"shift_jis", 932}, {"shift-jis", 932},
    {"euc-kr", 51949}, {"euc_kr", 51949},
    {"windows-1252", 1252}, {"iso-8859-1", 28591},
    {"ascii", 20127}, {"us-ascii", 20127},
  };
  UINT targetCp = 0;
  for (auto& m : CpMap) { if (_stricmp(target.c_str(), m.name) == 0) { targetCp = m.cp; break; } }

  std::vector<char> output(std::max<size_t>(input.size() * 4 + 1024, 4096));
  char detected[128] = {};
  int32_t written = smart_convert_encoding(
      reinterpret_cast<const uint8_t*>(input.data()),
      static_cast<int32_t>(input.size()),
      target.c_str(),
      output.data(),
      static_cast<int32_t>(output.size()),
      detected,
      static_cast<int32_t>(sizeof(detected)));

  if (written < 0) {
    output.assign(static_cast<size_t>(-written) + 1, '\0');
    written = smart_convert_encoding(
        reinterpret_cast<const uint8_t*>(input.data()),
        static_cast<int32_t>(input.size()),
        target.c_str(),
        output.data(),
        static_cast<int32_t>(output.size()),
        detected,
        static_cast<int32_t>(sizeof(detected)));
  }

  // Fallback: use Windows native API (UTF-8 → UTF-16 → target codepage)
  if (written <= 0 && targetCp > 0 && targetCp != CP_UTF8) {
    // Step 1: UTF-8 → UTF-16
    int wlen = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
      input.data(), static_cast<int>(input.size()), nullptr, 0);
    if (wlen <= 0) {
      wlen = MultiByteToWideChar(CP_UTF8, 0,
        input.data(), static_cast<int>(input.size()), nullptr, 0);
    }
    if (wlen > 0) {
      std::vector<WCHAR> wide(wlen + 1);
      MultiByteToWideChar(CP_UTF8, 0,
        input.data(), static_cast<int>(input.size()), wide.data(), wlen);
      wide[wlen] = 0;

      // Step 2: UTF-16 → target encoding
      int mblen = WideCharToMultiByte(targetCp, 0,
        wide.data(), wlen, nullptr, 0, nullptr, nullptr);
      if (mblen > 0) {
        output.assign(mblen + 1, '\0');
        int actual = WideCharToMultiByte(targetCp, 0,
          wide.data(), wlen, output.data(), mblen, nullptr, nullptr);
        if (actual > 0) {
          written = actual;
          strcpy_s(detected, "utf-8");
        }
      }
    }
  }

  std::string response;
  if (written <= 0) {
    response = "{\"ok\":false,\"error\":\"encoding conversion failed\"}";
  } else {
    response = "{\"ok\":true,\"detected\":\"" + JsonEscape(detected) +
               "\",\"output\":\"" + JsonEscape(std::string(output.data(), written)) + "\"}";
  }
  return jade_text_create(response.c_str());
}

const char* JADEVIEW_CALL ApplyTheme(uint32_t window_id, const char* payload) {
  DbgLog(std::string("IPC:apply_theme ") + (payload?payload:""));
  std::string json = payload ? payload : "";
  std::string theme = JsonStringValue(json, "theme");
  uint32_t target = window_id ? window_id : g_main_window;
  if (theme == "glass") {
    set_window_background_color(target, "#00000000");
    set_window_backdrop(target, "acrylic");
    set_window_theme(target, "Dark");
  } else if (theme == "white") {
    set_window_backdrop(target, "default");
    set_window_background_color(target, "#00000000");
    set_window_theme(target, "Light");
  } else {
    set_window_backdrop(target, "default");
    set_window_background_color(target, "#00000000");
    set_window_theme(target, "Dark");
  }
  return jade_text_create("{\"ok\":true}");
}

const char* JADEVIEW_CALL WindowControl(uint32_t window_id, const char* payload) {
  DbgLog(std::string("IPC:window_control ") + (payload?payload:""));
  std::string json = payload ? payload : "";
  std::string action = JsonStringValue(json, "action");
  uint32_t target = g_main_window ? g_main_window : window_id;
  int32_t result = 0;
  if (action == "minimize") {
    result = minimize_window(target);
  } else if (action == "maximize") {
    result = toggle_maximize_window(target);
    HWND hwnd = (HWND)get_window_hwnd(target);
    if (hwnd) {
      std::thread([hwnd]() {
        Sleep(120);
        ApplyWindowRoundedCorners(hwnd);
      }).detach();
    }
  } else if (action == "close") {
    result = close_window(target);
    RequestAppExit("window_control close");
  }
  Log("window_control action=" + action + " result=" + std::to_string(result));
  return jade_text_create((std::string("{\"ok\":") + (result ? "true" : "false") + "}").c_str());
}

// ══════════ TARGETING SYSTEM (AIMING RETICLE) ══════════
namespace {
HWND g_highlightWnd = nullptr;
HCURSOR g_oldCursor = nullptr;
bool g_targetingActive = false;

HWND CreateHighlightWindow() {
  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(WNDCLASSEXW);
  wc.lpfnWndProc = DefWindowProcW;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"JadeTargetHL";
  wc.hbrBackground = (HBRUSH)GetStockObject(NULL_BRUSH);
  RegisterClassExW(&wc);
  return CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
    L"JadeTargetHL", L"", WS_POPUP, 0, 0, 200, 200, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
}

void UpdateHighlight(HWND hwnd, RECT targetRect) {
  if (!hwnd) return;
  int bw = 4;
  SetWindowPos(hwnd, HWND_TOPMOST,
    targetRect.left - bw, targetRect.top - bw,
    targetRect.right - targetRect.left + bw*2,
    targetRect.bottom - targetRect.top + bw*2,
    SWP_NOACTIVATE | SWP_SHOWWINDOW);
  HDC hdc = GetDC(hwnd);
  if (hdc) {
    RECT rc = {}; GetClientRect(hwnd, &rc);
    HDC memDC = CreateCompatibleDC(hdc);
    HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
    HBITMAP oldBmp = (HBITMAP)SelectObject(memDC, bmp);
    HBRUSH br = CreateSolidBrush(RGB(0,0,0));
    FillRect(memDC, &rc, br);
    DeleteObject(br);
    HPEN pen = CreatePen(PS_SOLID, bw, RGB(255, 55, 55));
    HPEN oldPen = (HPEN)SelectObject(memDC, pen);
    SelectObject(memDC, GetStockObject(NULL_BRUSH));
    Rectangle(memDC, bw/2, bw/2, rc.right - bw/2, rc.bottom - bw/2);
    SelectObject(memDC, oldPen);
    DeleteObject(pen);
    BLENDFUNCTION bf = { AC_SRC_OVER, 0, 220, AC_SRC_ALPHA };
    POINT ptZero = {};
    SIZE sz = { rc.right, rc.bottom };
    UpdateLayeredWindow(hwnd, hdc, nullptr, &sz, memDC, &ptZero, 0, &bf, ULW_ALPHA);
    SelectObject(memDC, oldBmp);
    DeleteObject(bmp);
    DeleteDC(memDC);
    ReleaseDC(hwnd, hdc);
  }
}

void DestroyHighlight() {
  if (g_highlightWnd) { DestroyWindow(g_highlightWnd); g_highlightWnd = nullptr; }
}
} // namespace

const char* JADEVIEW_CALL PickMsaaWindow(uint32_t, const char*) {
  DbgLog("IPC:pick_msaa_window");
  if (g_targetingActive) return jade_text_create("{\"ok\":false,\"error\":\"already targeting\"}");
  g_targetingActive = true;

  // Create highlight window
  DestroyHighlight();
  g_highlightWnd = CreateHighlightWindow();

  // Set crosshair cursor
  HCURSOR cross = LoadCursorW(nullptr, IDC_CROSS);

  // Wait for left button down (start drag)
  DWORD startTick = GetTickCount();
  HWND lastTarget = nullptr;
  while ((GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0) {
    Sleep(20);
    if (GetTickCount() - startTick > 15000) { // timeout
      DestroyHighlight();
      g_targetingActive = false;
      return jade_text_create("{\"ok\":false,\"error\":\"timeout, no click\"}");
    }
  }

  // Left button held: tracking mode with red flashing border
  bool flashOn = true;
  DWORD lastFlash = 0;
  while (GetAsyncKeyState(VK_LBUTTON) & 0x8000) {
    POINT pt; GetCursorPos(&pt);
    HWND target = WindowFromPoint(pt);
    // Flash: toggle every 250ms
    DWORD now = GetTickCount();
    if (now - lastFlash > 250) { flashOn = !flashOn; lastFlash = now; }

    if (target != lastTarget) {
      lastTarget = target;
      if (target) {
        RECT tr = {}; GetWindowRect(target, &tr);
        UpdateHighlight(g_highlightWnd, tr);
        ShowWindow(g_highlightWnd, SW_SHOWNOACTIVATE);
      }
    }
    if (!flashOn && g_highlightWnd) ShowWindow(g_highlightWnd, SW_HIDE);
    else if (flashOn && g_highlightWnd && target) ShowWindow(g_highlightWnd, SW_SHOWNOACTIVATE);

    Sleep(30);
  }

  // Released: get final HWND
  POINT pt; GetCursorPos(&pt);
  HWND finalHwnd = WindowFromPoint(pt);

  DestroyHighlight();
  g_targetingActive = false;

  // Flash target window to confirm
  if (finalHwnd) {
    FLASHWINFO fi = {}; fi.cbSize = sizeof(fi); fi.hwnd = finalHwnd;
    fi.dwFlags = FLASHW_ALL; fi.uCount = 3; fi.dwTimeout = 100;
    FlashWindowEx(&fi);
  }

  char buf[128] = {};
  sprintf_s(buf, "{\"ok\":true,\"hwnd\":\"0x%p\"}", finalHwnd);
  Log(std::string("pick_msaa_window ") + buf);
  return jade_text_create(buf);
}

int CALLBACK EnumFontProc(const LOGFONTW* lf, const TEXTMETRICW*, DWORD, LPARAM) {
  if (lf && lf->lfFaceName[0]) g_fonts.insert(WideToUtf8(lf->lfFaceName));
  return 1;
}

const char* JADEVIEW_CALL GetFontList(uint32_t, const char*) {
  DbgLog("IPC:get_fonts");
  g_fonts.clear();
  HDC hdc = GetDC(nullptr);
  if (hdc) {
    LOGFONTW lf = {};
    lf.lfCharSet = DEFAULT_CHARSET;
    EnumFontFamiliesExW(hdc, &lf, reinterpret_cast<FONTENUMPROCW>(EnumFontProc), 0, 0);
    ReleaseDC(nullptr, hdc);
  }
  // Sort: fonts with Chinese characters first, then alphabetically
  std::vector<std::string> fonts(g_fonts.begin(), g_fonts.end());
  std::sort(fonts.begin(), fonts.end(), [](const std::string& a, const std::string& b) {
    auto hasCN = [](const std::string& s) {
      for (size_t i = 0; i < s.size();) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        if (c >= 0xE0 && i + 2 < s.size()) {
          // UTF-8 3-byte: check if in CJK range (U+4E00-U+9FFF -> E4 B8 80 ~ E9 BF BF)
          unsigned char c2 = static_cast<unsigned char>(s[i+1]);
          unsigned char c3 = static_cast<unsigned char>(s[i+2]);
          uint32_t cp = ((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F);
          if (cp >= 0x4E00 && cp <= 0x9FFF) return true;
          i += 3;
        } else if ((c & 0x80) == 0) { i++; }
        else if ((c & 0xE0) == 0xC0) { i += 2; }
        else { i += 3; }
      }
      return false;
    };
    bool aCN = hasCN(a), bCN = hasCN(b);
    if (aCN != bCN) return aCN;  // Chinese first
    return a < b;
  });
  std::string response = "{\"ok\":true,\"fonts\":[";
  bool first = true;
  for (const auto& font : fonts) {
    if (!first) response += ",";
    first = false;
    response += "\"" + JsonEscape(font) + "\"";
  }
  response += "]}";
  return jade_text_create(response.c_str());
}

const char* JADEVIEW_CALL SetStartup(uint32_t, const char* payload) {
  DbgLog(std::string("IPC:set_startup ") + (payload?payload:""));
  std::string json = payload ? payload : "";
  bool enabled = json.find("true") != std::string::npos || json.find("1") != std::string::npos;
  HKEY key = nullptr;
  LONG rc = RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr);
  if (rc != ERROR_SUCCESS) return jade_text_create("{\"ok\":false,\"error\":\"open registry failed\"}");
  if (enabled) {
    wchar_t exe[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    std::wstring quoted = L"\"" + std::wstring(exe) + L"\"";
    rc = RegSetValueExW(key, L"JadeProgrammerAssistant", 0, REG_SZ, reinterpret_cast<const BYTE*>(quoted.c_str()), static_cast<DWORD>((quoted.size() + 1) * sizeof(wchar_t)));
  } else {
    rc = RegDeleteValueW(key, L"JadeProgrammerAssistant");
    if (rc == ERROR_FILE_NOT_FOUND) rc = ERROR_SUCCESS;
  }
  RegCloseKey(key);
  return jade_text_create((std::string("{\"ok\":") + (rc == ERROR_SUCCESS ? "true" : "false") + "}").c_str());
}

const char* JADEVIEW_CALL TestLog(uint32_t, const char* payload) {
  if (g_test_log_file.empty()) return jade_text_create("{\"ok\":false}");
  std::ofstream out(g_test_log_file, std::ios::app | std::ios::binary);
  SYSTEMTIME st = {}; GetLocalTime(&st);
  char prefix[64] = {};
  sprintf_s(prefix, "[%04u-%02u-%02u %02u:%02u:%02u.%03u] ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
  std::string line = payload ? payload : "";
  for (char& ch : line) {
    if (ch == '\r' || ch == '\n' || ch == '\t') ch = ' ';
  }
  out << prefix << line << "\r\n";
  return jade_text_create("{\"ok\":true}");
}

std::string HwndHex(HWND hwnd) {
  char buf[32] = {};
  auto value = reinterpret_cast<uintptr_t>(hwnd);
  sprintf_s(buf, "0x%llX", static_cast<unsigned long long>(value));
  return std::string(buf);
}

// 快速提取16x16小图标 → base64 BMP data URL (用于进程列表)
std::string GetSmallIconB64(const std::wstring& exePath) {
  SHFILEINFOW sfi = {};
  if (!SHGetFileInfoW(exePath.c_str(), 0, &sfi, sizeof(sfi), SHGFI_ICON | SHGFI_SMALLICON) || !sfi.hIcon)
    return "";
  HICON hIcon = sfi.hIcon;
  const int sz = 16;
  HDC dc = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(dc);
  BITMAPINFO bi = {}; bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); bi.bmiHeader.biWidth = sz; bi.bmiHeader.biHeight = -sz; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr; HBITMAP bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bmp || !bits) { DeleteDC(mem); ReleaseDC(nullptr, dc); DestroyIcon(hIcon); return ""; }
  HBITMAP oldBmp = (HBITMAP)SelectObject(mem, bmp);
  DrawIconEx(mem, 0, 0, hIcon, sz, sz, 0, nullptr, DI_NORMAL);
  SelectObject(mem, oldBmp);
  DeleteDC(mem); ReleaseDC(nullptr, dc); DestroyIcon(hIcon);
  // 手动构造 BMP 格式: BITMAPFILEHEADER + BITMAPINFOHEADER (已存在) + 像素
  DWORD pixelSize = sz * sz * 4;
  DWORD fileSize = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER) + pixelSize;
  std::vector<uint8_t> bmpData(fileSize);
  auto* bf = reinterpret_cast<BITMAPFILEHEADER*>(bmpData.data());
  bf->bfType = 0x4D42;
  bf->bfSize = fileSize;
  bf->bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
  memcpy(bmpData.data() + sizeof(BITMAPFILEHEADER), &bi.bmiHeader, sizeof(BITMAPINFOHEADER));
  memcpy(bmpData.data() + bf->bfOffBits, bits, pixelSize);
  DeleteObject(bmp);
  // Base64 编码
  static const char* b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out; out.reserve(bmpData.size() * 4 / 3 + 4);
  for (size_t i = 0; i < bmpData.size(); i += 3) {
    uint8_t b0 = bmpData[i], b1 = (i+1<bmpData.size())?bmpData[i+1]:0, b2 = (i+2<bmpData.size())?bmpData[i+2]:0;
    out += b64[b0>>2]; out += b64[((b0&3)<<4)|(b1>>4)];
    out += (i+1<bmpData.size())?b64[((b1&15)<<2)|(b2>>6)]:'='; out += (i+2<bmpData.size())?b64[b2&63]:'=';
  }
  return out;
}

// NtQuerySystemInformation 用到的类型（一次调用拉全部进程基础信息）
typedef LONG NTSTATUS;
typedef struct _UNICODE_STRING { USHORT Length; USHORT MaximumLength; PWSTR Buffer; } UNICODE_STRING;
typedef struct _SYSTEM_PROCESS_INFORMATION {
  ULONG NextEntryOffset; ULONG NumberOfThreads;
  LARGE_INTEGER SpareLi1, SpareLi2, SpareLi3;
  LARGE_INTEGER CreateTime, UserTime, KernelTime;
  UNICODE_STRING ImageName; int BasePriority; HANDLE UniqueProcessId;
  HANDLE InheritedFromUniqueProcessId; ULONG HandleCount;
  ULONG SessionId; ULONG_PTR PageDirectoryBase;
  SIZE_T PeakVirtualSize, VirtualSize; ULONG PageFaultCount;
  SIZE_T PeakWorkingSetSize, WorkingSetSize;
  SIZE_T QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage;
  SIZE_T QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage;
  SIZE_T PagefileUsage, PeakPagefileUsage; SIZE_T PrivatePageCount;
  LARGE_INTEGER ReadOperationCount, WriteOperationCount, OtherOperationCount;
  LARGE_INTEGER ReadTransferCount, WriteTransferCount, OtherTransferCount;
} SYSTEM_PROCESS_INFORMATION;

const char* JADEVIEW_CALL ListProcesses(uint32_t, const char*) {
  auto t0 = std::chrono::steady_clock::now();

  // ══ 阶段1: NtQuerySystemInformation 一次调用拿全部基础信息 ══
  struct ProcBase { DWORD pid; DWORD ppid; DWORD threads; std::wstring name; SIZE_T memKB; LONGLONG userTime; LONGLONG kernelTime; };
  std::vector<ProcBase> entries;
  {
    using pNtQSI = NTSTATUS(WINAPI*)(ULONG, PVOID, ULONG, PULONG);
    auto NtQSI = reinterpret_cast<pNtQSI>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQuerySystemInformation"));
    if (!NtQSI) goto fallback;
    ULONG bufSize = 0x80000; // 512KB 初始缓冲
    std::vector<BYTE> buf;
    NTSTATUS st;
    do {
      buf.resize(bufSize);
      ULONG retLen = 0;
      st = NtQSI(0x05, buf.data(), static_cast<ULONG>(buf.size()), &retLen);
      if (st == 0xC0000004) { bufSize = retLen>bufSize?retLen:bufSize*2; continue; } // STATUS_INFO_LENGTH_MISMATCH
      if (st < 0) goto fallback;
      break;
    } while (bufSize < 4*1024*1024);
    if (st < 0) goto fallback;

    auto* pInfo = reinterpret_cast<SYSTEM_PROCESS_INFORMATION*>(buf.data());
    while (pInfo) {
      if (entries.size() >= 800) break;
      DWORD pid = static_cast<DWORD>(reinterpret_cast<uintptr_t>(pInfo->UniqueProcessId));
      DWORD ppid = static_cast<DWORD>(reinterpret_cast<uintptr_t>(pInfo->InheritedFromUniqueProcessId));
      std::wstring name;
      if (pInfo->ImageName.Buffer && pInfo->ImageName.Length > 0)
        name.assign(pInfo->ImageName.Buffer, pInfo->ImageName.Length / sizeof(wchar_t));
      entries.push_back({pid, ppid, pInfo->NumberOfThreads, std::move(name), pInfo->WorkingSetSize / 1024, pInfo->UserTime.QuadPart, pInfo->KernelTime.QuadPart});
      if (pInfo->NextEntryOffset == 0) break;
      pInfo = reinterpret_cast<SYSTEM_PROCESS_INFORMATION*>(reinterpret_cast<BYTE*>(pInfo) + pInfo->NextEntryOffset);
    }
  }

fallback:
  if (entries.empty()) {
    // 兜底：CreateToolhelp32Snapshot
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap != INVALID_HANDLE_VALUE) {
      PROCESSENTRY32W pe = {}; pe.dwSize = sizeof(pe);
      if (Process32FirstW(snap, &pe)) {
        do { if (entries.size()>=300) break; entries.push_back({pe.th32ProcessID, pe.th32ParentProcessID, pe.cntThreads, pe.szExeFile, 0, 0, 0}); }
        while (Process32NextW(snap, &pe));
      }
      CloseHandle(snap);
    }
  }
  auto t1 = std::chrono::steady_clock::now();
  Log("ListProcesses phase1 NT " + std::to_string(entries.size()) + " procs, " + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(t1-t0).count()) + "ms");
  if (entries.empty()) {
    return jade_text_create("{\"ok\":false,\"error\":\"process enumeration returned no entries\",\"items\":[]}");
  }

  // ══ 阶段2: 10线程并发查详情 (perm + path，仅 OpenProcess 1次/进程) ══
  const int NUM = (std::min)(10, static_cast<int>(entries.size()));
  struct ProcResult { int idx; std::string json; };
  std::vector<std::future<std::vector<ProcResult>>> futures;
  size_t chunk = (entries.size() + NUM - 1) / NUM;

  for (int t = 0; t < NUM; t++) {
    size_t start = t * chunk, end = (std::min)(start + chunk, entries.size());
    futures.push_back(std::async(std::launch::async, [&entries, start, end]() {
      std::vector<ProcResult> results; results.reserve(end - start);
      for (size_t i = start; i < end; i++) {
        auto& e = entries[i];
        std::string js = "{\"pid\":" + std::to_string(e.pid) + ",\"ppid\":" + std::to_string(e.ppid) + ",\"threads\":" + std::to_string(e.threads) + ",\"name\":\"" + JsonEscape(WideToUtf8(e.name)) + "\"";
        // 内存来自 NtQuerySystemInformation（有值就用，没值则查）
        if (e.memKB > 0) js += ",\"memKB\":" + std::to_string(e.memKB);
        // CPU 时间（用于计算 CPU 占用 %）
        js += ",\"cpuUser\":" + std::to_string(e.userTime) + ",\"cpuKernel\":" + std::to_string(e.kernelTime);
        // 单个 OpenProcess — PROCESS_QUERY_LIMITED_INFORMATION 足以做 token/内存/路径
        bool gotInfo = false;
        HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, e.pid);
        if (hProc) {
          gotInfo = true;
          // Permission
          HANDLE hToken = nullptr;
          if (OpenProcessToken(hProc, TOKEN_QUERY, &hToken)) {
            TOKEN_ELEVATION_TYPE elev = TokenElevationTypeDefault; DWORD sz = 0;
            GetTokenInformation(hToken, TokenElevationType, &elev, sizeof(elev), &sz);
            CloseHandle(hToken);
            js += ",\"perm\":\""; js += (elev == TokenElevationTypeFull ? "Admin" : "User"); js += "\"";
          } else { js += ",\"perm\":\"Sys\""; }
          // Memory (兜底，如果 NT API 没拿到)
          if (e.memKB == 0) {
            PROCESS_MEMORY_COUNTERS pmc = {};
            if (GetProcessMemoryInfo(hProc, &pmc, sizeof(pmc))) js += ",\"memKB\":" + std::to_string(pmc.WorkingSetSize / 1024);
          }
          // 进程列表保持轻量；打开位置/提取图标时再按 PID 查询路径。
          CloseHandle(hProc);
        }
        if (!gotInfo) js += ",\"perm\":\"---\"";
        js += "}";
        results.push_back({static_cast<int>(i), std::move(js)});
      }
      return results;
    }));
  }

  std::vector<std::string> resultJsons(entries.size());
  for (auto& f : futures) {
    for (auto& r : f.get()) resultJsons[r.idx] = std::move(r.json);
  }
  auto t2 = std::chrono::steady_clock::now();
  Log("ListProcesses phase2 details " + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(t2-t1).count()) + "ms");

  // ══ 阶段3: 拼接 JSON + 系统级内存/CPU ══
  MEMORYSTATUSEX memx = {sizeof(memx)};
  GlobalMemoryStatusEx(&memx);
  FILETIME idleT, kernelT, userT;
  GetSystemTimes(&idleT, &kernelT, &userT);
  ULARGE_INTEGER idleU, kernelU, userU;
  idleU.LowPart=idleT.dwLowDateTime; idleU.HighPart=idleT.dwHighDateTime;
  kernelU.LowPart=kernelT.dwLowDateTime; kernelU.HighPart=kernelT.dwHighDateTime;
  userU.LowPart=userT.dwLowDateTime; userU.HighPart=userT.dwHighDateTime;
  unsigned long long idleNow = idleU.QuadPart;
  unsigned long long kernelNow = kernelU.QuadPart;
  unsigned long long userNow = userU.QuadPart;
  unsigned long long idlePrev = g_lastCpuIdle.exchange(idleNow);
  unsigned long long kernelPrev = g_lastCpuKernel.exchange(kernelNow);
  unsigned long long userPrev = g_lastCpuUser.exchange(userNow);
  double cpuPct = -1.0;
  if (idlePrev && kernelPrev && userPrev) {
    unsigned long long dIdle = idleNow >= idlePrev ? idleNow - idlePrev : 0;
    unsigned long long dKernel = kernelNow >= kernelPrev ? kernelNow - kernelPrev : 0;
    unsigned long long dUser = userNow >= userPrev ? userNow - userPrev : 0;
    unsigned long long dTotal = dKernel + dUser;
    if (dTotal > 0) {
      cpuPct = (1.0 - (static_cast<double>(dIdle) / static_cast<double>(dTotal))) * 100.0;
      if (cpuPct < 0.0) cpuPct = 0.0;
      if (cpuPct > 100.0) cpuPct = 100.0;
    }
  }
  std::string response = "{\"ok\":true,\"items\":[";
  for (size_t i = 0; i < resultJsons.size(); i++) {
    if (i) response += ",";
    response += resultJsons[i];
  }
  response += "],\"count\":" + std::to_string(resultJsons.size())
    + ",\"cpuCount\":" + std::to_string(GetActiveProcessorCount(ALL_PROCESSOR_GROUPS))
    + ",\"sysMem\":{" 
    + "\"total\":" + std::to_string(memx.ullTotalPhys) 
    + ",\"avail\":" + std::to_string(memx.ullAvailPhys) 
    + ",\"load\":" + std::to_string(memx.dwMemoryLoad) + "}"
    + ",\"sysCpu\":{" 
    + "\"idle\":" + std::to_string(idleU.QuadPart) 
    + ",\"kernel\":" + std::to_string(kernelU.QuadPart) 
    + ",\"user\":" + std::to_string(userU.QuadPart)
    + ",\"pct\":" + (cpuPct >= 0.0 ? std::to_string(cpuPct) : std::string("null")) + "}" + "}";
  auto t3 = std::chrono::steady_clock::now();
  auto totalMs = std::chrono::duration_cast<std::chrono::milliseconds>(t3 - t0).count();
  Log("ListProcesses phase3 json " + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(t3-t2).count()) + "ms  total " + std::to_string(totalMs) + "ms");
  DbgLog(std::string("IPC:list_processes ") + std::to_string(resultJsons.size()) + " processes (" + std::to_string(totalMs) + "ms)");

  return jade_text_create(response.c_str());
}

const char* JADEVIEW_CALL KillProcess(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  DWORD pid = static_cast<DWORD>(ParseInteger(JsonStringValue(json, "pid")));
  DbgLog(std::string("IPC:kill_process PID=") + std::to_string(pid));
  if (!pid) { DbgLog("kill_process: invalid PID", true); return jade_text_create("{\"ok\":false,\"error\":\"invalid pid\"}"); }
  HANDLE hProc = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
  if (!hProc) { DbgLog(std::string("kill_process: OpenProcess failed (PID=") + std::to_string(pid) + ")", true); return jade_text_create("{\"ok\":false,\"error\":\"OpenProcess failed\"}"); }
  BOOL result = TerminateProcess(hProc, 1);
  CloseHandle(hProc);
  DbgLog(std::string("kill_process PID=") + std::to_string(pid) + (result ? " OK" : " FAILED"));
  return jade_text_create((std::string("{\"ok\":") + (result ? "true" : "false") + ",\"pid\":" + std::to_string(pid) + "}").c_str());
}

const char* JADEVIEW_CALL OpenProcessPath(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string exePath = JsonStringValue(json, "path");
  DbgLog(std::string("IPC:open_process_path path=") + exePath.substr(0, 100));
  // 优先用前端传的 path（list_processes 已获取），失败时用 PID 查询
  if (exePath.empty()) {
    DWORD pid = static_cast<DWORD>(ParseInteger(JsonStringValue(json, "pid")));
    if (!pid) return jade_text_create("{\"ok\":false,\"error\":\"no pid or path\"}");
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hProc) {
      wchar_t buf[MAX_PATH]={}; DWORD len=MAX_PATH;
      if(QueryFullProcessImageNameW(hProc,0,buf,&len)) exePath=WideToUtf8(buf);
      CloseHandle(hProc);
    }
  }
  if (exePath.empty()) return jade_text_create("{\"ok\":false,\"error\":\"no path\"}");
  std::wstring wpath = Utf8ToWide(exePath);
  std::wstring param = L"/select,\"" + wpath + L"\"";
  Log("open_process_path path="+exePath);
  ShellExecuteW(nullptr, L"open", L"explorer.exe", param.c_str(), nullptr, SW_SHOWNORMAL);
  return jade_text_create((std::string("{\"ok\":true,\"path\":\"")+JsonEscape(exePath)+"\"}").c_str());
}

struct WindowEnumContext { std::string json; int count = 0; bool first = true; };

BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM param) {
  auto* ctx = reinterpret_cast<WindowEnumContext*>(param);
  if (!IsWindowVisible(hwnd) || ctx->count >= 300) return TRUE;
  wchar_t title[512] = {}, cls[256] = {};
  GetWindowTextW(hwnd, title, 512);
  GetClassNameW(hwnd, cls, 256);
  RECT rect = {};
  GetWindowRect(hwnd, &rect);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (!ctx->first) ctx->json += ",";
  ctx->first = false;
  ctx->count++;
  ctx->json += "{\"hwnd\":\"" + HwndHex(hwnd) + "\"";
  ctx->json += ",\"title\":\"" + JsonEscape(WideToUtf8(title)) + "\"";
  ctx->json += ",\"className\":\"" + JsonEscape(WideToUtf8(cls)) + "\"";
  ctx->json += ",\"pid\":" + std::to_string(pid);
  ctx->json += ",\"rect\":{\"left\":" + std::to_string(rect.left) + ",\"top\":" + std::to_string(rect.top) + ",\"right\":" + std::to_string(rect.right) + ",\"bottom\":" + std::to_string(rect.bottom) + "}}";
  return TRUE;
}

const char* JADEVIEW_CALL SpyWindows(uint32_t, const char*) {
  DbgLog("IPC:spy_windows");
  WindowEnumContext ctx;
  ctx.json = "{\"ok\":true,\"items\":[";
  EnumWindows(EnumWindowsProc, reinterpret_cast<LPARAM>(&ctx));
  ctx.json += "],\"count\":" + std::to_string(ctx.count) + "}";
  return jade_text_create(ctx.json.c_str());
}

std::string WindowStyleText(LONG_PTR style, bool ex) {
  struct Flag { LONG_PTR value; const char* name; };
  static const Flag normal[] = {
    {WS_VISIBLE,"WS_VISIBLE"},{WS_DISABLED,"WS_DISABLED"},{WS_CHILD,"WS_CHILD"},{WS_POPUP,"WS_POPUP"},{WS_CAPTION,"WS_CAPTION"},
    {WS_SYSMENU,"WS_SYSMENU"},{WS_THICKFRAME,"WS_THICKFRAME"},{WS_MINIMIZEBOX,"WS_MINIMIZEBOX"},{WS_MAXIMIZEBOX,"WS_MAXIMIZEBOX"},
    {WS_CLIPSIBLINGS,"WS_CLIPSIBLINGS"},{WS_CLIPCHILDREN,"WS_CLIPCHILDREN"}
  };
  static const Flag extended[] = {
    {WS_EX_TOPMOST,"WS_EX_TOPMOST"},{WS_EX_TRANSPARENT,"WS_EX_TRANSPARENT"},{WS_EX_LAYERED,"WS_EX_LAYERED"},{WS_EX_TOOLWINDOW,"WS_EX_TOOLWINDOW"},
    {WS_EX_APPWINDOW,"WS_EX_APPWINDOW"},{WS_EX_CLIENTEDGE,"WS_EX_CLIENTEDGE"},{WS_EX_WINDOWEDGE,"WS_EX_WINDOWEDGE"},{WS_EX_NOACTIVATE,"WS_EX_NOACTIVATE"}
  };
  const Flag* flags = ex ? extended : normal;
  int count = ex ? ARRAYSIZE(extended) : ARRAYSIZE(normal);
  std::string text;
  for (int i = 0; i < count; ++i) {
    if ((style & flags[i].value) == flags[i].value) {
      if (!text.empty()) text += " | ";
      text += flags[i].name;
    }
  }
  return text.empty() ? "0" : text;
}

std::string WindowDetailJson(HWND hwnd) {
  if (!IsWindow(hwnd)) return "{\"ok\":false,\"error\":\"invalid hwnd\"}";
  wchar_t title[512] = {}, cls[256] = {}, module[1024] = {};
  GetWindowTextW(hwnd, title, 512);
  GetClassNameW(hwnd, cls, 256);
  GetWindowModuleFileNameW(hwnd, module, 1024);
  RECT rect = {}, client = {};
  GetWindowRect(hwnd, &rect);
  GetClientRect(hwnd, &client);
  DWORD pid = 0;
  DWORD tid = GetWindowThreadProcessId(hwnd, &pid);
  LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  HWND parent = GetParent(hwnd);
  HWND owner = GetWindow(hwnd, GW_OWNER);
  HWND first = GetWindow(hwnd, GW_HWNDFIRST);
  HWND last = GetWindow(hwnd, GW_HWNDLAST);
  HWND next = GetWindow(hwnd, GW_HWNDNEXT);
  HWND prev = GetWindow(hwnd, GW_HWNDPREV);
  HWND child = GetWindow(hwnd, GW_CHILD);
  std::string json = "{\"ok\":true";
  json += ",\"hwnd\":\"" + HwndHex(hwnd) + "\"";
  json += ",\"title\":\"" + JsonEscape(WideToUtf8(title)) + "\"";
  json += ",\"className\":\"" + JsonEscape(WideToUtf8(cls)) + "\"";
  json += ",\"module\":\"" + JsonEscape(WideToUtf8(module)) + "\"";
  json += ",\"pid\":" + std::to_string(pid) + ",\"tid\":" + std::to_string(tid);
  json += ",\"id\":" + std::to_string(GetDlgCtrlID(hwnd));
  json += ",\"rect\":{";
  json += "\"left\":" + std::to_string(rect.left) + ",\"top\":" + std::to_string(rect.top) + ",\"right\":" + std::to_string(rect.right) + ",\"bottom\":" + std::to_string(rect.bottom);
  json += ",\"width\":" + std::to_string(rect.right - rect.left) + ",\"height\":" + std::to_string(rect.bottom - rect.top) + "}";
  json += ",\"client\":{";
  json += "\"left\":" + std::to_string(client.left) + ",\"top\":" + std::to_string(client.top) + ",\"right\":" + std::to_string(client.right) + ",\"bottom\":" + std::to_string(client.bottom);
  json += ",\"width\":" + std::to_string(client.right - client.left) + ",\"height\":" + std::to_string(client.bottom - client.top) + "}";
  char styleHex[32] = {}, exHex[32] = {};
  sprintf_s(styleHex, "0x%08IX", style);
  sprintf_s(exHex, "0x%08IX", exStyle);
  json += ",\"style\":\"" + std::string(styleHex) + "\",\"styleText\":\"" + JsonEscape(WindowStyleText(style, false)) + "\"";
  json += ",\"exStyle\":\"" + std::string(exHex) + "\",\"exStyleText\":\"" + JsonEscape(WindowStyleText(exStyle, true)) + "\"";
  json += ",\"visible\":" + std::string(IsWindowVisible(hwnd) ? "true" : "false");
  json += ",\"enabled\":" + std::string(IsWindowEnabled(hwnd) ? "true" : "false");
  json += ",\"topmost\":" + std::string((exStyle & WS_EX_TOPMOST) ? "true" : "false");
  json += ",\"transparent\":" + std::string((exStyle & WS_EX_TRANSPARENT) ? "true" : "false");
  json += ",\"relations\":{";
  json += "\"parent\":\"" + HwndHex(parent) + "\",\"owner\":\"" + HwndHex(owner) + "\",\"first\":\"" + HwndHex(first) + "\",\"last\":\"" + HwndHex(last) + "\",\"next\":\"" + HwndHex(next) + "\",\"prev\":\"" + HwndHex(prev) + "\",\"child\":\"" + HwndHex(child) + "\"}";
  json += "}";
  return json;
}

const char* JADEVIEW_CALL SpyDetail(uint32_t, const char* payload) {
  DbgLog(std::string("IPC:spy_detail ") + JsonStringValue(payload?payload:"{}","hwnd"));
  HWND hwnd = ParseHwnd(JsonStringValue(payload ? payload : "", "hwnd"));
  std::string json = WindowDetailJson(hwnd);
  return jade_text_create(json.c_str());
}

// ══════════ 窗口图标 → Base64 PNG ══════════
std::string IconToBase64(HICON hIcon) {
  if(!hIcon) return "";
  Gdiplus::Bitmap bmp(16, 16, PixelFormat32bppARGB);
  Gdiplus::Graphics g(&bmp);
  g.Clear(Gdiplus::Color(0,0,0,0));
  HDC ghdc = g.GetHDC();
  DrawIconEx(ghdc, 0, 0, hIcon, 16, 16, 0, nullptr, DI_NORMAL);
  g.ReleaseHDC(ghdc);
  IStream* stream = nullptr;
  if(CreateStreamOnHGlobal(nullptr, TRUE, &stream) != S_OK) return "";
  CLSID pngClsid;
  if(CLSIDFromString(L"{557cf406-1a04-11d3-9a73-0000f81ef32e}",&pngClsid)!=NOERROR){stream->Release();return"";}
  if(bmp.Save(stream,&pngClsid)!=Gdiplus::Ok){stream->Release();return"";}
  STATSTG stg={};stream->Stat(&stg,STATFLAG_NONAME);
  ULONG size=(ULONG)stg.cbSize.QuadPart;
  std::vector<BYTE> data(size);
  LARGE_INTEGER li={};stream->Seek(li,STREAM_SEEK_SET,nullptr);
  ULONG read=0;stream->Read(data.data(),size,&read);stream->Release();
  if(read==0)return"";
  static const char* b64="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;out.reserve((size+2)/3*4);
  for(size_t i=0;i<size;i+=3){BYTE b0=data[i],b1=(i+1<size)?data[i+1]:0,b2=(i+2<size)?data[i+2]:0;out+=b64[b0>>2];out+=b64[((b0&3)<<4)|(b1>>4)];out+=(i+1<size)?b64[((b1&15)<<2)|(b2>>6)]:'=';out+=(i+2<size)?b64[b2&63]:'=';}
  if(out.size()<8||out.substr(0,8)!="iVBORw0K")return"";
  return"data:image/png;base64,"+out;
}

std::string WindowIconToBase64(HWND hwnd) {
  if (!hwnd || !IsWindow(hwnd)) return "";
  HICON hIcon = nullptr;
  // 1. 窗口自定义图标
  SendMessageTimeoutW(hwnd, WM_GETICON, ICON_BIG, 0, SMTO_ABORTIFHUNG, 200, (PDWORD_PTR)&hIcon);
  if (!hIcon) SendMessageTimeoutW(hwnd, WM_GETICON, ICON_SMALL, 0, SMTO_ABORTIFHUNG, 200, (PDWORD_PTR)&hIcon);
  if (!hIcon) SendMessageTimeoutW(hwnd, WM_GETICON, ICON_SMALL2, 0, SMTO_ABORTIFHUNG, 200, (PDWORD_PTR)&hIcon);
  // 2. 类默认图标
  if (!hIcon) hIcon = (HICON)GetClassLongPtrW(hwnd, GCLP_HICON);
  if (!hIcon) hIcon = (HICON)GetClassLongPtrW(hwnd, GCLP_HICONSM);
  // 3. 进程 exe 图标（所有权窗口）
  std::string result; bool needDestroy=false;
  if (hIcon) { result = IconToBase64(hIcon); DestroyIcon(hIcon); if(!result.empty()) return result; }
  // 4. SHGetFileInfo 从进程路径取图标
  DWORD pid=0; GetWindowThreadProcessId(hwnd, &pid);
  if(pid){
    HANDLE hp=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
    if(hp){wchar_t exe[MAX_PATH]={};DWORD len=MAX_PATH;if(QueryFullProcessImageNameW(hp,0,exe,&len)){
      SHFILEINFOW sfi={};
      if(SHGetFileInfoW(exe,0,&sfi,sizeof(sfi),SHGFI_ICON|SHGFI_SMALLICON)&&sfi.hIcon){
        result=IconToBase64(sfi.hIcon);DestroyIcon(sfi.hIcon);
        CloseHandle(hp);return result;
      }
    }CloseHandle(hp);}
  }
  return "";
}

// ══════════ 桌面窗口树 v5（递归子窗口，图标嵌入）══════════
struct SpyTreeCtx { int count=0; int maxCount=300; int maxDepth=3; };
std::string BuildSpyNode(HWND hwnd, SpyTreeCtx& ctx, int depth) {
  if(!IsWindow(hwnd) || ctx.count >= ctx.maxCount || depth > ctx.maxDepth) return "";
  wchar_t title[256]={}, cls[128]={};
  GetWindowTextW(hwnd, title, 256); GetClassNameW(hwnd, cls, 128);
  DWORD pid=0; GetWindowThreadProcessId(hwnd, &pid);
  RECT r={}; GetWindowRect(hwnd, &r);
  bool vis = IsWindowVisible(hwnd);
  ctx.count++;
  // 图标
  std::string iconStr;
  if(ctx.count<=100){std::string ico=WindowIconToBase64(hwnd);if(!ico.empty())iconStr=",\"icon\":\""+ico+"\"";}
  // 枚举子窗口
  std::string kids;
  int childVis=0, childAll=0;
  if(depth < ctx.maxDepth){
    for(HWND c=GetWindow(hwnd,GW_CHILD);c&&ctx.count<ctx.maxCount;c=GetWindow(c,GW_HWNDNEXT)){
      std::string cn = BuildSpyNode(c, ctx, depth+1);
      if(cn.empty()) continue;
      if(!kids.empty()) kids+=",";
      kids+=cn; childAll++;
      if(IsWindowVisible(c)) childVis++;
    }
  }
  char buf[4096];
  int n=sprintf_s(buf,"{\"hwnd\":\"%s\",\"className\":\"%s\",\"title\":\"%s\",\"pid\":%u,\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"visible\":%s,\"children\":[%s],\"childCount\":%d,\"childVis\":%d%s}",
    HwndHex(hwnd).c_str(),JsonEscape(WideToUtf8(cls)).c_str(),JsonEscape(WideToUtf8(title)).c_str(),
    pid,r.left,r.top,r.right-r.left,r.bottom-r.top,vis?"true":"false",
    kids.c_str(),childAll,childVis,iconStr.c_str());
  return (n>0&&n<(int)sizeof(buf))?std::string(buf):"";
}

BOOL CALLBACK SpyTreeEnumProc(HWND hwnd, LPARAM lParam) {
  auto* ctx = (SpyTreeCtx*)lParam;
  if(!IsWindowVisible(hwnd) || ctx->count >= ctx->maxCount) return TRUE;
  std::string node = BuildSpyNode(hwnd, *ctx, 0);
  return node.empty() ? TRUE : TRUE; // continue
}

const char* JADEVIEW_CALL SpyTree(uint32_t, const char*) {
  Log("SPY_TREE: v5 with children");
  SpyTreeCtx ctx;
  std::string json = "{\"ok\":true,\"items\":[";
  bool first=true;
  for(HWND hwnd=GetTopWindow(nullptr);hwnd&&ctx.count<ctx.maxCount;hwnd=GetWindow(hwnd,GW_HWNDNEXT)){
    if(!IsWindowVisible(hwnd)) continue;
    std::string node = BuildSpyNode(hwnd, ctx, 0);
    if(node.empty()) continue;
    if(!first) json+=","; first=false;
    json+=node;
    if(json.size()>500000) break;
  }
  json+="],\"count\":"+std::to_string(ctx.count)+"}";
  Log("SPY_TREE: done — "+std::to_string(ctx.count)+" nodes, jsonSize="+std::to_string(json.size()));
  return jade_text_create(json.c_str());
}

// ══════════ 按需获取单个窗口图标 ══════════
const char* JADEVIEW_CALL GetWindowIcon(uint32_t, const char* payload) {
  HWND hwnd = ParseHwnd(JsonStringValue(payload ? payload : "", "hwnd"));
  if(!hwnd || !IsWindow(hwnd)) return jade_text_create("{\"ok\":false}");
  std::string icon = WindowIconToBase64(hwnd);
  Log("ICON: "+HwndHex(hwnd)+" size="+std::to_string(icon.size()));
  return jade_text_create(("{\"ok\":true,\"hwnd\":\"" + HwndHex(hwnd) + "\",\"icon\":\"" + (icon.empty()?"":icon) + "\"}").c_str());
}

const char* JADEVIEW_CALL SpyChildTree(uint32_t, const char* payload) {
  DbgLog(std::string("IPC:spy_child_tree hwnd=") + JsonStringValue(payload?payload:"{}","hwnd"));
  HWND parent = ParseHwnd(JsonStringValue(payload ? payload : "", "hwnd"));
  if (!parent || !IsWindow(parent)) {
    return jade_text_create("{\"ok\":true,\"items\":[],\"count\":0}");
  }
  // 简化：仅枚举直接子窗口
  char buf[8192]; int pos=0;
  pos += sprintf_s(buf+pos, sizeof(buf)-pos, "{\"ok\":true,\"items\":[");
  bool first=true; int count=0;
  for (HWND child = GetWindow(parent, GW_CHILD); child && count < 100; child = GetWindow(child, GW_HWNDNEXT)) {
    wchar_t title[256]={}, cls[128]={};
    GetWindowTextW(child, title, 256);
    GetClassNameW(child, cls, 128);
    DWORD pid=0; GetWindowThreadProcessId(child, &pid);
    RECT r={}; GetWindowRect(child, &r);
    if(pos>6000) break;
    pos += sprintf_s(buf+pos, sizeof(buf)-pos,
      "%s{\"hwnd\":\"%s\",\"className\":\"%s\",\"title\":\"%s\",\"pid\":%u,\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"children\":[]}",
      first?"":",", HwndHex(child).c_str(),
      JsonEscape(WideToUtf8(cls)).c_str(),
      JsonEscape(WideToUtf8(title)).c_str(),
      pid, r.left, r.top, r.right-r.left, r.bottom-r.top);
    first=false; count++;
  }
  pos += sprintf_s(buf+pos, sizeof(buf)-pos, "],\"count\":%d}", count);
  return jade_text_create(buf);
}

std::string TrimProxyLine(std::string text) {
  if (text.size() >= 3 && static_cast<unsigned char>(text[0]) == 0xEF && static_cast<unsigned char>(text[1]) == 0xBB && static_cast<unsigned char>(text[2]) == 0xBF) text.erase(0, 3);
  while (!text.empty() && (text.back() == '\r' || text.back() == '\n' || text.back() == ' ' || text.back() == '\t')) text.pop_back();
  size_t start = 0;
  while (start < text.size() && (text[start] == ' ' || text[start] == '\t')) start++;
  return text.substr(start);
}

struct ProxyEntry { std::string original; std::string protocol; std::string host; int port = 0; bool valid = false; };
struct ProxyResult { ProxyEntry entry; bool alive = false; int latencyMs = 0; std::string error; };

ProxyEntry ParseProxyLine(const std::string& raw) {
  ProxyEntry entry;
  entry.original = TrimProxyLine(raw);
  entry.protocol = "http";
  std::string value = entry.original;
  if (value.empty() || value[0] == '#') return entry;
  size_t atProtocol = value.rfind('@');
  if (atProtocol != std::string::npos && atProtocol + 1 < value.size() && value.find("://") == std::string::npos) {
    entry.protocol = value.substr(atProtocol + 1);
    value = value.substr(0, atProtocol);
  }
  size_t scheme = value.find("://");
  if (scheme != std::string::npos) {
    entry.protocol = value.substr(0, scheme);
    value = value.substr(scheme + 3);
  }
  if (!value.empty() && value.front() == '[') {
    size_t end = value.find(']');
    if (end != std::string::npos && end + 2 <= value.size() && value[end + 1] == ':') {
      entry.host = value.substr(1, end - 1);
      entry.port = atoi(value.substr(end + 2).c_str());
    }
  } else {
    size_t colon = value.rfind(':');
    if (colon != std::string::npos) {
      entry.host = value.substr(0, colon);
      entry.port = atoi(value.substr(colon + 1).c_str());
    }
  }
  entry.valid = !entry.host.empty() && entry.port > 0 && entry.port <= 65535;
  return entry;
}

ProxyResult TestProxyTcp(const ProxyEntry& entry, int timeoutMs) {
  ProxyResult result;
  result.entry = entry;
  if (!entry.valid) { result.error = "invalid format"; return result; }
  addrinfo hints = {};
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_family = AF_UNSPEC;
  addrinfo* addresses = nullptr;
  std::string portText = std::to_string(entry.port);
  auto begin = std::chrono::steady_clock::now();
  if (getaddrinfo(entry.host.c_str(), portText.c_str(), &hints, &addresses) != 0) { result.error = "dns failed"; return result; }
  for (addrinfo* addr = addresses; addr; addr = addr->ai_next) {
    SOCKET sock = socket(addr->ai_family, addr->ai_socktype, addr->ai_protocol);
    if (sock == INVALID_SOCKET) continue;
    u_long nonblock = 1;
    ioctlsocket(sock, FIONBIO, &nonblock);
    int rc = connect(sock, addr->ai_addr, static_cast<int>(addr->ai_addrlen));
    if (rc == 0 || WSAGetLastError() == WSAEWOULDBLOCK || WSAGetLastError() == WSAEINPROGRESS) {
      fd_set writeSet, errorSet;
      FD_ZERO(&writeSet); FD_ZERO(&errorSet);
      FD_SET(sock, &writeSet); FD_SET(sock, &errorSet);
      timeval tv = {}; tv.tv_sec = timeoutMs / 1000; tv.tv_usec = (timeoutMs % 1000) * 1000;
      int selected = select(0, nullptr, &writeSet, &errorSet, &tv);
      if (selected > 0 && FD_ISSET(sock, &writeSet) && !FD_ISSET(sock, &errorSet)) {
        int socketError = 0; int len = sizeof(socketError);
        getsockopt(sock, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&socketError), &len);
        if (socketError == 0) {
          auto end = std::chrono::steady_clock::now();
          result.latencyMs = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(end - begin).count());
          result.alive = result.latencyMs <= timeoutMs;
          closesocket(sock);
          break;
        }
      }
    }
    closesocket(sock);
  }
  if (addresses) freeaddrinfo(addresses);
  if (!result.alive && result.error.empty()) result.error = "connect failed or timeout";
  return result;
}

const char* JADEVIEW_CALL ProxyValidate(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string input = JsonStringValue(json, "input");
  DbgLog(std::string("IPC:proxy_validate ") + std::to_string(std::count(input.begin(), input.end(), '\n')+1) + " proxies");
  int maxDelay = (std::max)(100, atoi(JsonStringValue(json, "maxDelayMs").c_str()));
  if (maxDelay <= 100) maxDelay = 3000;
  int limit = (std::max)(1, (std::min)(200, atoi(JsonStringValue(json, "concurrency").c_str())));
  if (limit <= 1) limit = 100;
  std::vector<ProxyEntry> entries;
  std::stringstream ss(input);
  std::string line;
  while (std::getline(ss, line) && entries.size() < 1000) {
    ProxyEntry entry = ParseProxyLine(line);
    if (!entry.original.empty() && entry.original[0] != '#') entries.push_back(entry);
  }
  std::vector<ProxyResult> results;
  std::vector<std::future<ProxyResult>> futures;
  for (const auto& entry : entries) {
    futures.emplace_back(std::async(std::launch::async, [entry, maxDelay]() { return TestProxyTcp(entry, maxDelay); }));
    if (static_cast<int>(futures.size()) >= limit) {
      results.push_back(futures.front().get());
      futures.erase(futures.begin());
    }
  }
  for (auto& f : futures) results.push_back(f.get());
  std::sort(results.begin(), results.end(), [](const ProxyResult& a, const ProxyResult& b) {
    if (a.alive != b.alive) return a.alive > b.alive;
    return a.latencyMs < b.latencyMs;
  });
  std::string out = "{\"ok\":true,\"total\":" + std::to_string(results.size()) + ",\"alive\":[";
  bool firstAlive = true, firstDead = true;
  std::string dead = "],\"dead\":[";
  for (const auto& item : results) {
    std::string row = "{\"proxy\":\"" + JsonEscape(item.entry.original) + "\",\"protocol\":\"" + JsonEscape(item.entry.protocol) + "\",\"host\":\"" + JsonEscape(item.entry.host) + "\",\"port\":" + std::to_string(item.entry.port) + ",\"latencyMs\":" + std::to_string(item.latencyMs) + ",\"error\":\"" + JsonEscape(item.error) + "\"}";
    if (item.alive) { if (!firstAlive) out += ","; firstAlive = false; out += row; }
    else { if (!firstDead) dead += ","; firstDead = false; dead += row; }
  }
  out += dead + "]}";
  return jade_text_create(out.c_str());
}

// ══════════ 屏幕取色 v11（最小化防键盘 + 统一颜色源 + 零闪烁） ══════════
HCURSOR CreateEyedropperCursor() {
  // 32×32 高精度十字准星光标，热点(15,15)为精确取色点
  BYTE andMsk[128]={},xorMsk[128]={};
  auto setPx=[&](int x,int y,bool black){
    if(x<0||x>=32||y<0||y>=32)return;
    int byteOff=y*4+x/8,bitOff=7-(x%8);
    andMsk[byteOff]&=~(1<<bitOff);
    if(black)xorMsk[byteOff]&=~(1<<bitOff); else xorMsk[byteOff]|=(1<<bitOff);
  };
  // 十字线（黑框+白芯，在各色背景上都可见）
  for(int x=0;x<32;x++){setPx(x,15,true);setPx(x,14,false);setPx(x,16,false);} // 水平黑线+白边
  for(int y=0;y<32;y++){setPx(15,y,true);setPx(14,y,false);setPx(16,y,false);} // 垂直黑线+白边
  // 中心 3×3 白色方块（精准取色点）
  for(int y=14;y<=16;y++)for(int x=14;x<=16;x++)setPx(x,y,false);
  // 外圈细环（提示范围）
  for(int a=0;a<360;a+=15){
    int x=15+(int)(12*cos(a*3.14159/180)), y=15+(int)(12*sin(a*3.14159/180));
    setPx(x,y,true);
  }
  return CreateCursor(GetModuleHandleW(nullptr),15,15,32,32,andMsk,xorMsk);
}
const char* JADEVIEW_CALL PickScreenColor(uint32_t, const char*) {
  Log("══════ PICK ENTER ══════ wvlc=" + std::to_string(g_webview_load_count));
  DbgLog("IPC:pick_screen_color v14 Win32-hide");

  // ★ 用 Win32 ShowWindow 隐藏（不触发 webview lifecycle 事件）★
  HWND mainHwnd = g_main_window ? (HWND)get_window_hwnd(g_main_window) : nullptr;
  if(mainHwnd){ Log("PICK: ShowWindow(SW_HIDE)"); ShowWindow(mainHwnd, SW_HIDE); }
  Sleep(100);
  Log("PICK: main window hidden, entering setup");

  int sw=GetSystemMetrics(SM_CXSCREEN), sh=GetSystemMetrics(SM_CYSCREEN);
  const int MZ=4, MW=200, MH=160, PANEL_H=52, W=MW, H=MH+PANEL_H;
  const int LENS_SRC_W=MW/MZ, LENS_SRC_H=MH/MZ; // 50×40
  const int CAP_W=LENS_SRC_W+8, CAP_H=LENS_SRC_H+8; // 58×48
  HDC capDC=CreateCompatibleDC(nullptr);
  BITMAPINFO capBI={}; capBI.bmiHeader.biSize=sizeof(BITMAPINFOHEADER); capBI.bmiHeader.biWidth=CAP_W; capBI.bmiHeader.biHeight=-CAP_H; capBI.bmiHeader.biPlanes=1; capBI.bmiHeader.biBitCount=32; capBI.bmiHeader.biCompression=BI_RGB;
  void* capBits=nullptr;
  HBITMAP capBmp=CreateDIBSection(nullptr,&capBI,DIB_RGB_COLORS,&capBits,nullptr,0);
  SelectObject(capDC,capBmp);
  HDC screenDC=GetDC(nullptr);

  HCURSOR hEye=CreateEyedropperCursor();

  BITMAPINFO dInfo={}; dInfo.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);
  dInfo.bmiHeader.biWidth=W; dInfo.bmiHeader.biHeight=-H; dInfo.bmiHeader.biPlanes=1; dInfo.bmiHeader.biBitCount=32; dInfo.bmiHeader.biCompression=BI_RGB;
  void* bits=nullptr;
  HDC scrDC=GetDC(nullptr); HBITMAP dib=CreateDIBSection(scrDC,&dInfo,DIB_RGB_COLORS,&bits,nullptr,0); ReleaseDC(nullptr,scrDC);
  HDC dibDC=CreateCompatibleDC(nullptr); HBITMAP oldDibBmp=(HBITMAP)SelectObject(dibDC,dib);
  HFONT hexFont=CreateFontW(22,0,0,0,FW_BOLD,0,0,0,0,0,0,0,0,L"Consolas");
  HFONT rgbFont=CreateFontW(13,0,0,0,FW_NORMAL,0,0,0,0,0,0,0,0,L"Consolas");

  // 窗口：无 WS_EX_TRANSPARENT → 阻挡键盘 + SetFocus 吃 Enter
  WNDCLASSEXW wc={}; wc.cbSize=sizeof(wc);
  wc.lpfnWndProc=DefWindowProcW; wc.hInstance=GetModuleHandleW(nullptr);
  wc.lpszClassName=L"JadePickV13"; wc.hCursor=hEye;
  RegisterClassExW(&wc);
  HWND wnd=CreateWindowExW(WS_EX_LAYERED|WS_EX_TOPMOST|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW,
    L"JadePickV13",L"",WS_POPUP,0,0,W,H,nullptr,nullptr,wc.hInstance,nullptr);
  if(!wnd){Log("PICK: ERROR window creation failed"); SelectObject(dibDC,oldDibBmp);DeleteObject(dib);DeleteDC(dibDC);DeleteObject(hexFont);DeleteObject(rgbFont);DestroyCursor(hEye);if(mainHwnd)ShowWindow(mainHwnd,SW_SHOW);return jade_text_create("{\"ok\":false,\"error\":\"window failed\"}");}
  HRGN rgn=CreateRoundRectRgn(0,0,W,H,14,14); SetWindowRgn(wnd,rgn,TRUE);
  ShowWindow(wnd,SW_SHOWNOACTIVATE);
  SetFocus(wnd); // 键盘焦点归取色窗，Enter/Esc 报到 DefWindowProc 不进 webview

  // 状态
  int r=0,g=0,b=0,cx=sw/2,cy=sh/2;
  bool done=false,cancelled=false;

  // 防重复边沿检测
  bool prevEnter=false,prevSpace=false,prevEsc=false,prevL=false,prevR=false;

  MSG msg={};
  while(!done&&!cancelled){
    // ★ 只处理取色窗口的消息，不分发给其他窗口（尤其是主窗口）★
    while(PeekMessageW(&msg,wnd,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}
    // —— 键盘边沿检测（webview 已最小化，无需防泄漏） ——
    { bool cur=(GetAsyncKeyState(VK_RETURN)&0x8000)!=0; if(cur&&!prevEnter){Log("PICK: ★ Enter pressed → done  wvlc="+std::to_string(g_webview_load_count));done=true;break;} prevEnter=cur; }
    { bool cur=(GetAsyncKeyState(VK_SPACE)&0x8000)!=0; if(cur&&!prevSpace){Log("PICK: Space pressed → done");done=true;break;} prevSpace=cur; }
    { bool cur=(GetAsyncKeyState(VK_ESCAPE)&0x8000)!=0; if(cur&&!prevEsc){Log("PICK: Esc pressed → cancelled");cancelled=true;break;} prevEsc=cur; }
    { bool cur=(GetAsyncKeyState(VK_LBUTTON)&0x8000)!=0; if(cur&&!prevL){Log("PICK: LButton → done");done=true;break;} prevL=cur; }
    { bool cur=(GetAsyncKeyState(VK_RBUTTON)&0x8000)!=0; if(cur&&!prevR){Log("PICK: RButton → cancelled");cancelled=true;break;} prevR=cur; }
    // 方向键
    bool l=(GetAsyncKeyState(VK_LEFT)&0x8000)!=0, rt=(GetAsyncKeyState(VK_RIGHT)&0x8000)!=0;
    bool u=(GetAsyncKeyState(VK_UP)&0x8000)!=0,  d=(GetAsyncKeyState(VK_DOWN)&0x8000)!=0;
    bool nudging=l||rt||u||d;
    { static DWORD tn=0; if(nudging&&GetTickCount()-tn>=50){if(l){cx--;if(cx<0)cx=0;}if(rt){cx++;if(cx>=sw)cx=sw-1;}if(u){cy--;if(cy<0)cy=0;}if(d){cy++;if(cy>=sh)cy=sh-1;}SetCursorPos(cx,cy);tn=GetTickCount();} }
    if(!nudging){POINT pt;GetCursorPos(&pt);cx=pt.x;cy=pt.y;}
    if(cx<0)cx=0;if(cx>=sw)cx=sw-1;if(cy<0)cy=0;if(cy>=sh)cy=sh-1;

    // —— 窗口在旧位置（距光标≥24px），截屏后读颜色，再移新位置 ——
    int capX=cx-CAP_W/2, capY=cy-CAP_H/2;
    if(capX<0)capX=0;if(capY<0)capY=0;
    if(capX+CAP_W>sw)capX=sw-CAP_W;if(capY+CAP_H>sh)capY=sh-CAP_H;
    BitBlt(capDC,0,0,CAP_W,CAP_H,screenDC,capX,capY,SRCCOPY|CAPTUREBLT);

    // 从 capBits 读中心像素 → r,g,b（与放大镜 100% 同源）
    int localX=cx-capX, localY=cy-capY;
    int ci=(localY*CAP_W+localX)*4;
    BYTE* cap=(BYTE*)capBits;
    if(ci>=0&&ci+2<(int)(CAP_W*CAP_H*4)){b=cap[ci]; g=cap[ci+1]; r=cap[ci+2];}
    else{b=g=r=0;}

    // 移到显示位置
    int wx=cx+24,wy=cy+24;
    if(wx+W>sw-10)wx=cx-W-24; if(wy+H>sh-10)wy=cy-H-24;
    SetWindowPos(wnd,HWND_TOPMOST,wx,wy,W,H,SWP_NOACTIVATE|SWP_SHOWWINDOW);

    // ── 直接写 DIB 像素（alpha=255 完全不透明，零闪烁） ──
    BYTE* row=(BYTE*)bits;
    memset(row,0,W*H*4);
    auto PX=[&](int x,int y,BYTE rr,BYTE gg,BYTE bb){
      if((unsigned)x>=(unsigned)W||(unsigned)y>=(unsigned)H)return;
      int i=(y*W+x)*4; row[i]=bb; row[i+1]=gg; row[i+2]=rr; row[i+3]=255;
    };
    auto FILL=[&](int x0,int y0,int x1,int y1,BYTE rr,BYTE gg,BYTE bb){
      for(int yy=y0;yy<y1;yy++)for(int xx=x0;xx<x1;xx++)PX(xx,yy,rr,gg,bb);
    };
    auto HLINE=[&](int x0,int x1,int y,BYTE rr,BYTE gg,BYTE bb){
      for(int xx=x0;xx<=x1;xx++)PX(xx,y,rr,gg,bb);
    };
    auto VLINE=[&](int x,int y0,int y1,BYTE rr,BYTE gg,BYTE bb){
      for(int yy=y0;yy<=y1;yy++)PX(x,yy,rr,gg,bb);
    };

    // 背景
    FILL(0,0,W,H,14,14,22);
    // 边框
    HLINE(0,W-1,0,50,55,70); HLINE(0,W-1,H-1,50,55,70);
    VLINE(0,0,H-1,50,55,70); VLINE(W-1,0,H-1,50,55,70);

    // 放大镜格子（使用实时捕获 capBits）
    int hsx=MW/MZ/2, hsy=MH/MZ/2; // ★ x/y 分开：MW≠MH ★
    for(int dy=0;dy<MH;dy+=MZ)for(int dx=0;dx<MW;dx+=MZ){
      int sx=cx-hsx+dx/MZ, sy=cy-hsy+dy/MZ;
      int cxIdx=(sx-capX), cyIdx=(sy-capY);
      if(cxIdx>=0&&cxIdx<CAP_W&&cyIdx>=0&&cyIdx<CAP_H){
        int ii=(cyIdx*CAP_W+cxIdx)*4;
        FILL(dx,dy,dx+MZ,dy+MZ,cap[ii+2],cap[ii+1],cap[ii+0]);
      } else FILL(dx,dy,dx+MZ,dy+MZ,8,8,14);
    }

    // ★ 中心像素高亮框（白色 2px 外框，清晰标识取色像素） ★
    int cx0=(MW-MZ)/2, cy0=(MH-MZ)/2; // 中心 MZ×MZ 格子的左上角
    HLINE(cx0-2,cx0+MZ+1,cy0-2,255,255,255); HLINE(cx0-2,cx0+MZ+1,cy0-1,255,255,255);
    HLINE(cx0-2,cx0+MZ+1,cy0+MZ,255,255,255); HLINE(cx0-2,cx0+MZ+1,cy0+MZ+1,255,255,255);
    VLINE(cx0-2,cy0-2,cy0+MZ+1,255,255,255); VLINE(cx0-1,cy0-2,cy0+MZ+1,255,255,255);
    VLINE(cx0+MZ,cy0-2,cy0+MZ+1,255,255,255); VLINE(cx0+MZ+1,cy0-2,cy0+MZ+1,255,255,255);
    // 十字靶心
    int mx=MW/2,my=MH/2; BYTE ir=255-r,ig=255-g,ib=255-b;
    HLINE(mx-20,mx-8,my,ir,ig,ib); HLINE(mx+8,mx+20,my,ir,ig,ib);
    VLINE(mx,my-20,my-8,ir,ig,ib); VLINE(mx,my+8,my+20,ir,ig,ib);

    // 分隔线
    HLINE(0,W-1,MH,40,44,58);
    // 右下色块
    FILL(W-40,MH+5,W-8,MH+44,r,g,b);
    HLINE(W-41,W-7,MH+4,200,210,230); HLINE(W-41,W-7,MH+45,200,210,230);
    VLINE(W-41,MH+4,MH+45,200,210,230); VLINE(W-7,MH+4,MH+45,200,210,230);

    // GDI 文字（正确恢复旧对象，无泄漏）
    char hex[16]; sprintf_s(hex,"#%02X%02X%02X",r,g,b);
    char rs[36]; sprintf_s(rs,"rgb(%d, %d, %d)",r,g,b);
    SetBkMode(dibDC,TRANSPARENT);
    auto oldFnt=(HFONT)SelectObject(dibDC,hexFont);
    SetTextColor(dibDC,RGB(255,255,255)); TextOutA(dibDC,9,MH+4,hex,(int)strlen(hex));
    SelectObject(dibDC,rgbFont);
    SetTextColor(dibDC,RGB(160,175,200)); TextOutA(dibDC,12,MH+28,rs,(int)strlen(rs));
    SelectObject(dibDC,oldFnt);
    GdiFlush();

    // UpdateLayeredWindow（DIB 自带 alpha=255 全通道 → 无闪烁）
    // UpdateLayeredWindow（DIB 自带 alpha=255 全通道 → 无闪烁）
    BLENDFUNCTION bf={AC_SRC_OVER,0,255,AC_SRC_ALPHA};
    POINT zp={}; SIZE sz={W,H};
    UpdateLayeredWindow(wnd,nullptr,nullptr,&sz,dibDC,&zp,0,&bf,ULW_ALPHA);
    SetCursor(hEye);  // 每帧强制覆盖桌面光标
    Sleep(16);
  }

  Log("PICK: loop exit — done=" + std::to_string(done) + " cancelled=" + std::to_string(cancelled) + " wvlc=" + std::to_string(g_webview_load_count));

  // 清理
  SelectObject(dibDC,oldDibBmp); DeleteDC(dibDC);
  DeleteObject(hexFont); DeleteObject(rgbFont); DeleteObject(dib);
  DeleteDC(capDC); DeleteObject(capBmp); ReleaseDC(nullptr,screenDC);
  DestroyWindow(wnd); DeleteObject(rgn); DestroyCursor(hEye); UnregisterClassW(L"JadePickV13",wc.hInstance);

  // ★ Win32 ShowWindow 恢复（不触发 webview 重载）★
  if(mainHwnd){ Log("PICK: restoring main window (ShowWindow SW_SHOW)"); ShowWindow(mainHwnd, SW_SHOW); SetForegroundWindow(mainHwnd); }
  if(cancelled){Log("PICK: returning cancelled"); DbgLog("pick_screen_color: cancelled",true); return jade_text_create("{\"ok\":false,\"error\":\"cancelled\"}");}

  char hex[16]={};sprintf_s(hex,"#%02X%02X%02X",r,g,b);
  std::string resp="{\"ok\":true,\"hex\":\""+std::string(hex)+"\",\"r\":"+std::to_string(r)+",\"g\":"+std::to_string(g)+",\"b\":"+std::to_string(b)+",\"x\":"+std::to_string(cx)+",\"y\":"+std::to_string(cy)+"}";
  Log("PICK: returning " + std::string(hex) + " wvlc=" + std::to_string(g_webview_load_count));
  DbgLog(std::string("pick_screen_color: ")+std::string(hex));
  return jade_text_create(resp.c_str());
}

const char* JADEVIEW_CALL HashText(uint32_t, const char* payload) {
  DbgLog(std::string("IPC:hash_text algo=") + JsonStringValue(payload?payload:"{}","algo"));
  std::string json = payload ? payload : "";
  std::string algorithm = JsonStringValue(json, "algorithm");
  std::string text = JsonStringValue(json, "text");
  if (algorithm != "SHA-1" && algorithm != "SHA-256" && algorithm != "SHA-384" && algorithm != "SHA-512") {
    return jade_text_create("{\"ok\":false,\"error\":\"unsupported algorithm\"}");
  }
  std::string digest = HashTextSha(algorithm, text);
  if (digest.empty()) return jade_text_create("{\"ok\":false,\"error\":\"hash failed\"}");
  std::string response = "{\"ok\":true,\"hash\":\"" + digest + "\"}";
  return jade_text_create(response.c_str());
}

// 提取进程图标到 BMP，返回 base64 数据 URL（用于列表懒加载 + 保存）
std::string ExtractIconBmp64(const std::wstring& exePath, int size, std::wstring* outFileName) {
  SHFILEINFOW sfi = {};
  if (!SHGetFileInfoW(exePath.c_str(), 0, &sfi, sizeof(sfi), SHGFI_ICON | (size>32?SHGFI_LARGEICON:SHGFI_SMALLICON)) || !sfi.hIcon) return "";
  HICON hIcon = sfi.hIcon;
  HDC dc = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(dc);
  BITMAPINFO bi = {}; bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); bi.bmiHeader.biWidth = size; bi.bmiHeader.biHeight = -size; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr; HBITMAP bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bmp || !bits) { DeleteDC(mem); ReleaseDC(nullptr, dc); DestroyIcon(hIcon); return ""; }
  HBITMAP oldBmp = (HBITMAP)SelectObject(mem, bmp);
  DrawIconEx(mem, 0, 0, hIcon, size, size, 0, nullptr, DI_NORMAL);
  SelectObject(mem, oldBmp);
  DeleteDC(mem); ReleaseDC(nullptr, dc); DestroyIcon(hIcon);
  // BMP 编码
  DWORD pixelSize = size * size * 4;
  DWORD fileSize = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER) + pixelSize;
  std::vector<uint8_t> bmpData(fileSize);
  auto* bf = reinterpret_cast<BITMAPFILEHEADER*>(bmpData.data());
  bf->bfType = 0x4D42; bf->bfSize = fileSize; bf->bfOffBits = sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
  memcpy(bmpData.data() + sizeof(BITMAPFILEHEADER), &bi.bmiHeader, sizeof(BITMAPINFOHEADER));
  memcpy(bmpData.data() + bf->bfOffBits, bits, pixelSize);
  DeleteObject(bmp);
  // 建议文件名
  if (outFileName) {
    auto fn = std::filesystem::path(exePath).stem().wstring();
    *outFileName = fn + L".bmp";
  }
  // Base64
  static const char* b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out; out.reserve(bmpData.size()*4/3+4);
  for(size_t i=0;i<bmpData.size();i+=3){
    uint8_t b0=bmpData[i],b1=(i+1<bmpData.size())?bmpData[i+1]:0,b2=(i+2<bmpData.size())?bmpData[i+2]:0;
    out+=b64[b0>>2];out+=b64[((b0&3)<<4)|(b1>>4)];
    out+=(i+1<bmpData.size())?b64[((b1&15)<<2)|(b2>>6)]:'=';out+=(i+2<bmpData.size())?b64[b2&63]:'=';
  }
  return out;
}

// 保存图标为 .ico — 从 GetIconInfo 原始位图构建
const char* JADEVIEW_CALL SaveProcIcon(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  DWORD pid = static_cast<DWORD>(ParseInteger(JsonStringValue(json, "pid")));
  std::string exePath = JsonStringValue(json, "path");
  if (exePath.empty() && pid) {
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hProc) { wchar_t buf[MAX_PATH]={}; DWORD len=MAX_PATH; if(QueryFullProcessImageNameW(hProc,0,buf,&len)) exePath=WideToUtf8(buf); CloseHandle(hProc); }
  }
  if (exePath.empty()) return jade_text_create("{\"ok\":false,\"error\":\"no exe path\"}");
  std::wstring wpath = Utf8ToWide(exePath);
  auto fn = std::filesystem::path(wpath).stem().wstring();

  wchar_t savePath[MAX_PATH]={}; wcscpy_s(savePath,(fn+L".ico").c_str());
  OPENFILENAMEW ofn={sizeof(ofn)}; ofn.lpstrFile=savePath; ofn.nMaxFile=MAX_PATH;
  ofn.lpstrFilter=L"Icon (*.ico)\0*.ico\0\0"; ofn.lpstrDefExt=L"ico";
  ofn.Flags=OFN_OVERWRITEPROMPT|OFN_PATHMUSTEXIST;
  if(!GetSaveFileNameW(&ofn)) return jade_text_create("{\"ok\":false,\"error\":\"cancelled\"}");

  // 获取HICON + ICONINFO
  SHFILEINFOW sfi={};
  if(!SHGetFileInfoW(wpath.c_str(),0,&sfi,sizeof(sfi),SHGFI_ICON|SHGFI_LARGEICON)||!sfi.hIcon)
    return jade_text_create("{\"ok\":false,\"error\":\"no icon\"}");
  ICONINFO ii={};
  if(!GetIconInfo(sfi.hIcon,&ii)){ DestroyIcon(sfi.hIcon); return jade_text_create("{\"ok\":false,\"error\":\"GetIconInfo failed\"}"); }
  DestroyIcon(sfi.hIcon);

  // 从 hbmColor 获取尺寸和像素
  BITMAP bm={}; GetObjectW(ii.hbmColor,sizeof(BITMAP),&bm);
  int w=bm.bmWidth, h=bm.bmHeight;
  DWORD pxSize=w*h*4;
  std::vector<BYTE> px(pxSize);
  HDC hdc=GetDC(nullptr);
  BITMAPINFO bi={}; bi.bmiHeader.biSize=sizeof(BITMAPINFOHEADER); bi.bmiHeader.biWidth=w; bi.bmiHeader.biHeight=h; bi.bmiHeader.biPlanes=1; bi.bmiHeader.biBitCount=32; bi.bmiHeader.biCompression=BI_RGB;
  GetDIBits(hdc,ii.hbmColor,0,h,px.data(),&bi,DIB_RGB_COLORS);

  // AND mask (1bpp)
  DWORD maskRow=((w+31)/32)*4; std::vector<BYTE> mask(maskRow*h);
  BITMAPINFO mi={}; mi.bmiHeader.biSize=sizeof(BITMAPINFOHEADER); mi.bmiHeader.biWidth=w; mi.bmiHeader.biHeight=h; mi.bmiHeader.biPlanes=1; mi.bmiHeader.biBitCount=1; mi.bmiHeader.biCompression=BI_RGB;
  GetDIBits(hdc,ii.hbmMask,0,h,mask.data(),&mi,DIB_RGB_COLORS);
  ReleaseDC(nullptr,hdc);
  DeleteObject(ii.hbmColor); DeleteObject(ii.hbmMask);

  // 构建 ICO: ICONDIR(6) + ICONDIRENTRY(16) + BITMAPINFOHEADER(40) + XOR + AND
  DWORD dataOff=22, imgSize=40+pxSize+mask.size();
  std::vector<BYTE> ico(dataOff+imgSize);
  ico[2]=1; ico[4]=1; // ICONDIR
  ico[6]=(BYTE)(w>255?0:w); ico[7]=(BYTE)(h>255?0:h);
  ico[10]=1; ico[12]=32;
  memcpy(ico.data()+14,&imgSize,4); memcpy(ico.data()+18,&dataOff,4);
  auto*bh=(BITMAPINFOHEADER*)(ico.data()+dataOff);
  bh->biSize=40; bh->biWidth=w; bh->biHeight=h*2; bh->biPlanes=1; bh->biBitCount=32; bh->biCompression=BI_RGB;
  memcpy(ico.data()+dataOff+40,px.data(),pxSize);
  memcpy(ico.data()+dataOff+40+pxSize,mask.data(),mask.size());

  std::ofstream fout(savePath,std::ios::binary);
  if(!fout){return jade_text_create("{\"ok\":false,\"error\":\"write failed\"}");}
  fout.write((const char*)ico.data(),ico.size()); fout.close();
  Log("save_proc_icon ico "+std::to_string(w)+"x"+std::to_string(h));
  return jade_text_create((std::string("{\"ok\":true,\"path\":\"")+JsonEscape(WideToUtf8(savePath))+"\"}").c_str());
}

const char* JADEVIEW_CALL ExtractProcIcon(uint32_t, const char* payload) {
  DbgLog(std::string("IPC:extract_icon PID=") + JsonStringValue(payload?payload:"{}","pid"));
  std::string json = payload ? payload : "";
  DWORD pid = static_cast<DWORD>(ParseInteger(JsonStringValue(json, "pid")));
  std::string exePath = JsonStringValue(json, "path");
  if (exePath.empty() && pid) {
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hProc) {
      wchar_t buf[MAX_PATH]={}; DWORD len=MAX_PATH;
      if (QueryFullProcessImageNameW(hProc,0,buf,&len)) exePath=WideToUtf8(buf);
      CloseHandle(hProc);
    }
  }
  if (exePath.empty()) return jade_text_create("{\"ok\":false,\"error\":\"no exe path\"}");
  std::wstring wpath = Utf8ToWide(exePath);
  std::wstring saveName;
  // 16px 用于列表懒加载, 48px 用于保存
  std::string b64Small = ExtractIconBmp64(wpath, 16, nullptr);
  std::string b64Large = ExtractIconBmp64(wpath, 48, &saveName);
  if (b64Large.empty() && b64Small.empty())
    return jade_text_create("{\"ok\":false,\"error\":\"icon extract failed\"}");

  // 如果有保存路径参数，直接写文件
  std::string savePath = JsonStringValue(json, "savePath");
  if (!savePath.empty() && !b64Large.empty()) {
    // Decode base64 and write BMP
    static const unsigned char decode[128] = {
      64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,
      64,64,64,64,64,64,64,64,64,64,64,62,64,64,64,63,52,53,54,55,56,57,58,59,60,61,64,64,64,64,64,64,
      64, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,64,64,64,64,64,
      64,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,64,64,64,64,64
    };
    std::vector<uint8_t> bin;
    for(size_t i=0;i<b64Large.length();i+=4){
      uint8_t a=decode[(uint8_t)b64Large[i]],b=decode[(uint8_t)b64Large[i+1]],c=decode[(uint8_t)b64Large[i+2]],d=decode[(uint8_t)b64Large[i+3]];
      if(a>63||b>63)break;
      bin.push_back((a<<2)|(b>>4));
      if(c<=63){bin.push_back((b<<4)|(c>>2));if(d<=63)bin.push_back((c<<6)|d);}
    }
    std::ofstream out(Utf8ToWide(savePath), std::ios::binary);
    if(!out) return jade_text_create("{\"ok\":false,\"error\":\"save failed\"}");
    out.write(reinterpret_cast<const char*>(bin.data()), bin.size());
    out.close();
    return jade_text_create((std::string("{\"ok\":true,\"saved\":\"")+JsonEscape(savePath)+"\"}").c_str());
  }

  Log("extract_icon ok small="+std::to_string(b64Small.size())+" large="+std::to_string(b64Large.size())+" saveName="+WideToUtf8(saveName));
  std::string resp = "{\"ok\":true";
  if(!b64Small.empty()) resp+=",\"icon_base64\":\"data:image/bmp;base64,"+b64Small+"\"";
  if(!b64Large.empty()) resp+=",\"icon_large_b64\":\""+b64Large+"\"";
  resp+=",\"saveName\":\""+JsonEscape(WideToUtf8(saveName))+"\"}";
  return jade_text_create(resp.c_str());
}

const char* JADEVIEW_CALL SaveTextFile(uint32_t, const char* payload) {
  DbgLog(std::string("IPC:save_text path=") + JsonStringValue(payload?payload:"{}","path").substr(0,80));
  std::string json = payload ? payload : "";
  std::string path = JsonStringValue(json, "path");
  std::string text = JsonStringValue(json, "text");
  std::string append = JsonStringValue(json, "append");
  if (path.empty()) return jade_text_create("{\"ok\":false,\"error\":\"empty path\"}");
  try {
    std::filesystem::path out_path = Utf8ToWide(path);
    if (out_path.has_parent_path()) std::filesystem::create_directories(out_path.parent_path());
    std::ofstream file(out_path, std::ios::binary | (append == "true" ? std::ios::app : std::ios::trunc));
    if (!file) return jade_text_create("{\"ok\":false,\"error\":\"open file failed\"}");
    file << text;
    return jade_text_create("{\"ok\":true}");
  } catch (const std::exception& ex) {
    std::string response = "{\"ok\":false,\"error\":\"" + JsonEscape(ex.what()) + "\"}";
    return jade_text_create(response.c_str());
  }
}

const char* JADEVIEW_CALL NativeHttpRequest(uint32_t, const char* payload) {
  DbgLog(std::string("IPC:native_http ") + JsonStringValue(payload?payload:"{}", "method") + " " + JsonStringValue(payload?payload:"{}", "url").substr(0,80));
  DWORD start = GetTickCount();
  std::string json = payload ? payload : "";
  std::string method = JsonStringValue(json, "method");
  std::string url = JsonStringValue(json, "url");
  std::string body = JsonStringValue(json, "body");
  std::string headers_text = JsonStringValue(json, "headersText");
  std::string proxy = JsonStringValue(json, "proxy");
  std::string protocol = JsonStringValue(json, "protocol");  // auto / http1.1 / http2
  if (method.empty()) method = "GET";
  // 记录等价 curl（bash 单引号格式），便于在浏览器/终端直接复现这次请求
  {
    auto sq = [](const std::string& s){ std::string o; o.reserve(s.size()+8);
      for (char c : s){ if (c=='\'') o += "'\\''"; else o.push_back(c); } return o; };
    std::string curl = "curl '" + sq(url) + "'";
    if (method != "GET") curl += " -X " + method;
    std::istringstream chs(headers_text); std::string chl;
    while (std::getline(chs, chl)) {
      while (!chl.empty() && (chl.back()=='\r'||chl.back()=='\n')) chl.pop_back();
      if (chl.empty() || chl.find(':') == std::string::npos) continue;
      curl += " -H '" + sq(chl) + "'";
    }
    if (!body.empty()) curl += " --data-raw '" + sq(body) + "'";
    DbgLog("native_http curl: " + curl);
  }
  URL_COMPONENTSW parts = {};
  parts.dwStructSize = sizeof(parts);
  wchar_t host[512] = {}, path[4096] = {}, extra[2048] = {};
  parts.lpszHostName = host; parts.dwHostNameLength = 512;
  parts.lpszUrlPath = path; parts.dwUrlPathLength = 4096;
  parts.lpszExtraInfo = extra; parts.dwExtraInfoLength = 2048;
  std::wstring wurl = Utf8ToWide(url);
  if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &parts)) return jade_text_create("{\"ok\":false,\"error\":\"invalid url\"}");
  std::wstring request_path(parts.lpszUrlPath, parts.dwUrlPathLength);
  if (parts.dwExtraInfoLength) request_path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
  HINTERNET session = proxy.empty()
    ? WinHttpOpen(L"Jade Programmer Assistant/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)
    : WinHttpOpen(L"Jade Programmer Assistant/1.0", WINHTTP_ACCESS_TYPE_NAMED_PROXY, Utf8ToWide(proxy).c_str(), WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) return jade_text_create("{\"ok\":false,\"error\":\"WinHttpOpen failed\"}");
  // 关键修复：WinHTTP 默认 DNS 解析超时=无限(0)，国服网络偶发解析/连接卡顿会让同步调用永不返回，
  // IPC 永不 resolve，前端就永远停在「请求中」。设置有界超时，保证本函数必定返回。
  // 参数：解析 / 连接 / 发送 / 接收（毫秒）
  WinHttpSetTimeouts(session, 10000, 10000, 30000, 30000);
  HINTERNET connect = WinHttpConnect(session, std::wstring(parts.lpszHostName, parts.dwHostNameLength).c_str(), parts.nPort, 0);
  HINTERNET request = connect ? WinHttpOpenRequest(connect, Utf8ToWide(method).c_str(), request_path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0) : nullptr;
  // 按协议偏好启用 HTTP/2（仅 HTTPS 有效；选 http1.1 则不启用 → 强制 1.1；auto/http2 允许协商 h2）
  if (request && parts.nScheme == INTERNET_SCHEME_HTTPS && protocol != "http1.1") {
    DWORD enableProto = WINHTTP_PROTOCOL_FLAG_HTTP2;
    WinHttpSetOption(request, WINHTTP_OPTION_ENABLE_HTTP_PROTOCOL, &enableProto, sizeof(enableProto));
  }
  // gzip/deflate/br 自动解压（Win8.1+；旧系统/不支持时 SetOption 返回 FALSE，无副作用）。
  // 否则请求带 Accept-Encoding: gzip 时响应体是压缩字节，前端显示为乱码。
#ifdef WINHTTP_OPTION_DECOMPRESSION
  if (request) {
    DWORD decompress = WINHTTP_DECOMPRESSION_FLAG_ALL;
    WinHttpSetOption(request, WINHTTP_OPTION_DECOMPRESSION, &decompress, sizeof(decompress));
  }
#endif
  // 逐行添加请求头：跳过无冒号的非法行（如从浏览器“复制为 cURL”误带的请求行 "POST /... HTTP/2"），
  // 以及由 WinHTTP 自行管理的受限头（Host/Content-Length/Connection/Accept-Encoding 等）。
  // 否则把整坨头一次性交给 WinHttpSendRequest，遇到这些非法/受限项会整体报 87 ERROR_INVALID_PARAMETER。
  int hdrAdded = 0, hdrSkipped = 0;
  if (request && !headers_text.empty()) {
    std::istringstream hs(headers_text);
    std::string ln;
    while (std::getline(hs, ln)) {
      while (!ln.empty() && (ln.back()=='\r'||ln.back()=='\n'||ln.back()==' '||ln.back()=='\t')) ln.pop_back();
      size_t colon = ln.find(':');
      if (ln.empty()) continue;
      if (colon == 0 || colon == std::string::npos) { hdrSkipped++; continue; }  // 无冒号=非法行(请求行等)
      std::string key = ln.substr(0, colon);
      size_t a = key.find_first_not_of(" \t"), b = key.find_last_not_of(" \t");
      key = (a == std::string::npos) ? "" : key.substr(a, b - a + 1);
      std::string low = key; for (auto& c : low) c = (char)tolower((unsigned char)c);
      if (low=="host" || low=="content-length" || low=="connection" || low=="proxy-connection" ||
          low=="transfer-encoding" || low=="accept-encoding") { hdrSkipped++; continue; }  // WinHTTP 自管
      std::wstring wln = Utf8ToWide(ln);
      if (WinHttpAddRequestHeaders(request, wln.c_str(), (DWORD)-1L, WINHTTP_ADDREQ_FLAG_ADD)) hdrAdded++;
      else hdrSkipped++;
    }
  }
  BOOL sent = request && WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                  body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)body.data(),
                  (DWORD)body.size(), (DWORD)body.size(), 0);
  BOOL ok = sent && WinHttpReceiveResponse(request, nullptr);
  DWORD lastErr = ok ? 0 : GetLastError();  // 失败时立即抓 WinHTTP 错误码，供前端显示可读原因
  DWORD status = 0, statusSize = sizeof(status);
  if (ok) WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &status, &statusSize, nullptr);
  DWORD headerSize = 0;
  WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, nullptr, nullptr, &headerSize, nullptr);
  std::wstring rawHeaders;
  if (headerSize) { rawHeaders.resize(headerSize / sizeof(wchar_t)); WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, nullptr, rawHeaders.data(), &headerSize, nullptr); }
  std::string responseBody;
  if (ok) {
    DWORD available = 0;
    while (WinHttpQueryDataAvailable(request, &available) && available) {
      std::string chunk(available, '\0'); DWORD read = 0;
      if (!WinHttpReadData(request, chunk.data(), available, &read)) break;
      chunk.resize(read); responseBody += chunk;
    }
  }
  // 查询实际协商使用的协议版本，供前端 Type 指标显示真实结果
  std::string httpVersion = "HTTP/1.1";
  if (ok) {
    DWORD usedProto = 0, usedLen = sizeof(usedProto);
    if (WinHttpQueryOption(request, WINHTTP_OPTION_HTTP_PROTOCOL_USED, &usedProto, &usedLen)) {
      if (usedProto & WINHTTP_PROTOCOL_FLAG_HTTP2) httpVersion = "HTTP/2";
#ifdef WINHTTP_PROTOCOL_FLAG_HTTP3
      else if (usedProto & WINHTTP_PROTOCOL_FLAG_HTTP3) httpVersion = "HTTP/3";
#endif
    }
  }
  // 失败时把可读错误写进 body：前端 .then 会把 data.body 显示出来，避免界面只剩空白/卡住
  if (!ok) {
    const char* em =
      lastErr == 87    ? "（参数无效：可能仍含非法/受限请求头）" :
      lastErr == 12002 ? "（请求超时）" :
      lastErr == 12007 ? "（域名无法解析）" :
      lastErr == 12029 ? "（无法连接到服务器）" :
      lastErr == 12030 ? "（连接被重置/中断）" :
      lastErr == 12152 ? "（服务器响应无效）" :
      lastErr == 12175 ? "（TLS/证书错误）" : "";
    responseBody = std::string("[原生请求失败] WinHTTP 错误 ") + std::to_string(lastErr) + em;
  }
  if (request) WinHttpCloseHandle(request); if (connect) WinHttpCloseHandle(connect); if (session) WinHttpCloseHandle(session);
  DWORD elapsed = GetTickCount() - start;
  // 详细日志（写入 logs/startup.log，便于测试版排查）
  DbgLog("native_http <= " + method + " " + url.substr(0,120) +
         " | 头(加=" + std::to_string(hdrAdded) + " 跳=" + std::to_string(hdrSkipped) + ")" +
         " body=" + std::to_string(body.size()) + "B" +
         (ok ? (" | OK status=" + std::to_string(status) + " " + httpVersion +
                " resp=" + std::to_string(responseBody.size()) + "B " + std::to_string(elapsed) + "ms")
             : (" | FAIL WinHTTP=" + std::to_string(lastErr) + " " + std::to_string(elapsed) + "ms")),
         !ok);
  std::string resp = "{\"ok\":" + std::string(ok ? "true" : "false") + ",\"status\":" + std::to_string(status) + ",\"elapsedMs\":" + std::to_string(elapsed) + ",\"httpVersion\":\"" + httpVersion + "\",\"headers\":\"" + JsonEscape(WideToUtf8(rawHeaders)) + "\",\"body\":\"" + JsonEscape(responseBody) + "\"}";
  return jade_text_create(resp.c_str());
}

const char* JADEVIEW_CALL InspectMsaa(uint32_t, const char* payload) {
  DbgLog(std::string("IPC:inspect_msaa hwnd=") + JsonStringValue(payload?payload:"{}","hwnd"));
  HRESULT coHr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  bool coInitialized = SUCCEEDED(coHr);
  std::string json = payload ? payload : "";
  std::string hwnd_text = JsonStringValue(json, "hwnd");
  HWND hwnd = reinterpret_cast<HWND>(ParseInteger(hwnd_text));
  Log("inspect_msaa hwnd=" + hwnd_text);
  if (!hwnd || !IsWindow(hwnd)) {
    if (coInitialized) CoUninitialize();
    return jade_text_create("{\"ok\":false,\"error\":\"invalid hwnd\"}");
  }

  wchar_t title[512] = {};
  wchar_t class_name[256] = {};
  GetWindowTextW(hwnd, title, 512);
  GetClassNameW(hwnd, class_name, 256);
  RECT rect = {};
  GetWindowRect(hwnd, &rect);

  IAccessible* clientAcc = nullptr;
  IAccessible* windowAcc = nullptr;
  HRESULT clientHr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, reinterpret_cast<void**>(&clientAcc));
  HRESULT windowHr = AccessibleObjectFromWindow(hwnd, OBJID_WINDOW, IID_IAccessible, reinterpret_cast<void**>(&windowAcc));
  std::string response = "{\"ok\":true";
  response += ",\"window\":{";
  response += "\"hwnd\":\"0x" + [&]() { char buf[32] = {}; sprintf_s(buf, "%p", hwnd); return std::string(buf); }() + "\",";
  response += "\"title\":\"" + JsonEscape(WideToUtf8(title)) + "\",";
  response += "\"className\":\"" + JsonEscape(WideToUtf8(class_name)) + "\",";
  response += "\"rect\":{";
  response += "\"left\":" + std::to_string(rect.left) + ",\"top\":" + std::to_string(rect.top) + ",\"right\":" + std::to_string(rect.right) + ",\"bottom\":" + std::to_string(rect.bottom) + "}";
  response += "}";

  if ((FAILED(clientHr) || !clientAcc) && (FAILED(windowHr) || !windowAcc)) {
    response += ",\"accessible\":null,\"msaaError\":\"AccessibleObjectFromWindow failed: client=0x";
    char hrbufClient[16] = {};
    char hrbufWindow[16] = {};
    sprintf_s(hrbufClient, "%08X", static_cast<unsigned int>(clientHr));
    sprintf_s(hrbufWindow, "%08X", static_cast<unsigned int>(windowHr));
    response += hrbufClient;
    response += ", window=0x";
    response += hrbufWindow;
    response += "\"}";
    if (coInitialized) CoUninitialize();
    return jade_text_create(response.c_str());
  }

  MsaaTreeBuildResult clientTree;
  MsaaTreeBuildResult windowTree;
  if (clientAcc) clientTree = BuildMsaaTree(clientAcc);
  if (windowAcc) windowTree = BuildMsaaTree(windowAcc);

  const MsaaTreeBuildResult* chosen = nullptr;
  const char* chosenSource = "";
  if (clientTree.ok && windowTree.ok) {
    bool preferWindow =
      (windowTree.nodeCount > clientTree.nodeCount) ||
      (windowTree.nodeCount == clientTree.nodeCount && windowTree.rootChildCount > clientTree.rootChildCount) ||
      (clientTree.nodeCount <= 1 && windowTree.nodeCount > clientTree.nodeCount);
    chosen = preferWindow ? &windowTree : &clientTree;
    chosenSource = preferWindow ? "window" : "client";
  } else if (windowTree.ok) {
    chosen = &windowTree;
    chosenSource = "window";
  } else if (clientTree.ok) {
    chosen = &clientTree;
    chosenSource = "client";
  } else {
    chosen = clientAcc ? &clientTree : &windowTree;
    chosenSource = clientAcc ? "client" : "window";
  }

  response += ",\"tree\":" + (chosen ? chosen->treeJson : std::string("{}"));
  response += ",\"nodeCount\":" + std::to_string(chosen ? chosen->nodeCount : 0);
  response += ",\"maxNodes\":" + std::to_string(MSAA_MAX_NODES);
  response += ",\"maxDepth\":" + std::to_string(MSAA_MAX_DEPTH);
  response += ",\"nodeLimit\":" + std::to_string(chosen && chosen->truncated ? 1 : 0);
  response += ",\"truncated\":" + std::string(chosen && chosen->truncated ? "true" : "false");
  response += ",\"accessibleSource\":\"" + std::string(chosenSource) + "\"";
  response += ",\"clientNodeCount\":" + std::to_string(clientTree.nodeCount);
  response += ",\"windowNodeCount\":" + std::to_string(windowTree.nodeCount) + "}";
  if (clientAcc) clientAcc->Release();
  if (windowAcc && windowAcc != clientAcc) windowAcc->Release();
  if (coInitialized) CoUninitialize();
  return jade_text_create(response.c_str());
}

const char* JADEVIEW_CALL LogEvent(uint32_t window_id, const char* payload) {
  std::string pl = payload ? payload : "";
  Log("EVENT win=" + std::to_string(window_id) + " " + pl);
  if (pl.find("crash") != std::string::npos) { DbgLog("!!! WEBVIEW CRASH !!! " + pl, true); Log("!!! WEBVIEW CRASH !!! " + pl); }
  else DbgLog("Event: " + pl.substr(0, 80));
  return jade_text_create("{}");
}

const char* JADEVIEW_CALL OnWebViewLoad(uint32_t window_id, const char* payload) {
  g_webview_load_count++;
  Log("WEBVIEW_LOAD #" + std::to_string(g_webview_load_count) + " win=" + std::to_string(window_id));
  DbgLog("WEBVIEW_LOAD #" + std::to_string(g_webview_load_count) + " — restoring window", true);
  // 只在首次加载完成时显示窗口；后续 DID_FINISH_LOAD（页内重载/子框架）不再切换可见性，避免闪烁。
  if (g_main_window && !g_window_shown) {
    g_window_shown = true;
    set_window_visible(g_main_window, 1); /* 不 focus，防止 webview 重载回环 */
  }
  return jade_text_create("{}");
}

const char* JADEVIEW_CALL OnWindowClosed(uint32_t window_id, const char* payload) {
  Log("WINDOW_CLOSED win=" + std::to_string(window_id) + " " + (payload ? payload : ""));
  // 仅主窗口关闭（或全部窗口关闭 window_id==0）才退出应用；
  // 关闭标注工作台等次级窗口不应关掉整个软件
  if (window_id == g_main_window || window_id == 0) {
    if (window_id == g_main_window) g_main_window = 0;
    RequestAppExit("main window closed");
  } else {
    Log("secondary window closed, app stays alive");
  }
  return jade_text_create("{}");
}

// 原生拖放：WebView2 里 HTML 拿不到真实路径，靠 JadeView 的 drag-drop 事件把路径转发给 JS
const char* JADEVIEW_CALL OnDragDrop(uint32_t window_id, const char* payload) {
  std::string p = payload ? payload : "";
  DbgLog("DRAG_DROP win=" + std::to_string(window_id) + " " + p.substr(0, 300));
  std::string js = "window.__jadeDrop&&window.__jadeDrop(\"" + JsonEscape(p) + "\")";
  execute_javascript(window_id, js.c_str());
  return jade_text_create("{}");
}

// ══════════ 原生 WebSocket 桥接（WinHTTP，支持自定义 Cookie / Header）══════════
// 浏览器 new WebSocket() 不允许设置 Cookie 头，需携带 cookie 的 wss 必须走原生。
// 前端通过 ws_open / ws_send / ws_poll / ws_close 四个通道使用，消息用轮询拉取，
// 不依赖原生→JS 推送，避免跨线程调用 WebView。
struct WsBridgeConn {
  HINTERNET hSession = nullptr;
  HINTERNET hConnect = nullptr;
  HINTERNET hWebSocket = nullptr;
  std::thread recvThread;
  std::mutex mtx;                       // 保护 incoming 与 state
  std::deque<std::string> incoming;     // 收到的完整文本消息队列
  std::string state = "connecting";     // connecting / open / closed / error
  std::atomic_bool open{false};
  std::atomic_bool stop{false};
};

std::mutex g_wsBridgeMtx;
std::map<uint32_t, std::shared_ptr<WsBridgeConn>> g_wsBridge;
std::atomic<uint32_t> g_wsBridgeNextId{1};

std::shared_ptr<WsBridgeConn> WsBridgeFind(uint32_t id) {
  std::lock_guard<std::mutex> lk(g_wsBridgeMtx);
  auto it = g_wsBridge.find(id);
  return it == g_wsBridge.end() ? nullptr : it->second;
}

// WinHTTP 错误码 → 可读中文后缀（供 WS 日志显示真实原因）
static std::string WsErrSuffix(DWORD e) {
  switch (e) {
    case 12002: return " (请求超时)";
    case 12007: return " (域名无法解析)";
    case 12029: return " (无法连接到服务器)";
    case 12030: return " (连接被重置/中断)";
    case 12152: return " (服务器响应无效)";
    case 12175: return " (TLS/证书错误)";
    default: return "";
  }
}

const char* JADEVIEW_CALL WsOpen(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string url = JsonStringValue(json, "url");
  std::string cookie = JsonStringValue(json, "cookie");
  std::string headers = JsonStringValue(json, "headers");  // 每行 "Key: Value"
  DbgLog("IPC:ws_open url=" + url + " cookie_len=" + std::to_string(cookie.size()));
  if (url.empty()) return jade_text_create("{\"ok\":false,\"error\":\"empty url\"}");

  // ws:// → http://，wss:// → https://，以便 WinHttpCrackUrl 识别
  bool secure = false;
  std::wstring wurl;
  if (url.rfind("wss://", 0) == 0) { secure = true; wurl = L"https://" + Utf8ToWide(url.substr(6)); }
  else if (url.rfind("ws://", 0) == 0) { secure = false; wurl = L"http://" + Utf8ToWide(url.substr(5)); }
  else if (url.rfind("https://", 0) == 0) { secure = true; wurl = Utf8ToWide(url); }
  else if (url.rfind("http://", 0) == 0) { secure = false; wurl = Utf8ToWide(url); }
  else { secure = true; wurl = L"https://" + Utf8ToWide(url); }

  URL_COMPONENTS uc = {}; uc.dwStructSize = sizeof(uc);
  wchar_t host[256] = {}; wchar_t path[2048] = {}; wchar_t extra[2048] = {};
  uc.lpszHostName = host; uc.dwHostNameLength = 255;
  uc.lpszUrlPath = path; uc.dwUrlPathLength = 2047;
  uc.lpszExtraInfo = extra; uc.dwExtraInfoLength = 2047;
  if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc))
    return jade_text_create("{\"ok\":false,\"error\":\"bad url\"}");
  INTERNET_PORT port = uc.nPort;
  // 按【长度】构造，不依赖 WinHttpCrackUrl 写入调用方缓冲区时的空终止——直接用 host 缓冲区
  // 会偶发拿到非干净的主机名，导致 WinHttpSendRequest 报 12007 NAME_NOT_RESOLVED。
  // （与 NativeHttpRequest 的取法保持一致，那条路就没问题。）
  std::wstring hostName(uc.lpszHostName, uc.dwHostNameLength);
  std::wstring reqPath(uc.lpszUrlPath, uc.dwUrlPathLength);
  if (uc.dwExtraInfoLength) reqPath.append(uc.lpszExtraInfo, uc.dwExtraInfoLength);
  DbgLog("IPC:ws_open parsed host=[" + WideToUtf8(hostName) + "] port=" + std::to_string(port) +
         " pathLen=" + std::to_string(reqPath.size()));

  HINTERNET hSession = WinHttpOpen(L"JadeProgAsst/1.3", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                   WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!hSession) return jade_text_create("{\"ok\":false,\"error\":\"WinHttpOpen failed\"}");
  WinHttpSetTimeouts(hSession, 10000, 10000, 30000, 30000); // 解析/连接/发送/接收(ms)，防止永久卡死
  HINTERNET hConnect = WinHttpConnect(hSession, hostName.c_str(), port, 0);
  if (!hConnect) { WinHttpCloseHandle(hSession); return jade_text_create("{\"ok\":false,\"error\":\"connect failed\"}"); }
  DWORD reqFlags = secure ? WINHTTP_FLAG_SECURE : 0;
  HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", reqPath.c_str(), nullptr,
                                          WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, reqFlags);
  if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
    return jade_text_create("{\"ok\":false,\"error\":\"open request failed\"}"); }

  auto cleanupReq = [&]() {
    if (hRequest) WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
  };

  if (!cookie.empty()) {
    std::wstring h = L"Cookie: " + Utf8ToWide(cookie);
    WinHttpAddRequestHeaders(hRequest, h.c_str(), (DWORD)-1L,
                             WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
  }
  if (!headers.empty()) {
    std::istringstream ss(headers);
    std::string ln;
    while (std::getline(ss, ln)) {
      while (!ln.empty() && (ln.back() == '\r' || ln.back() == '\n' || ln.back() == ' ' || ln.back() == '\t')) ln.pop_back();
      if (ln.empty() || ln.find(':') == std::string::npos) continue;
      std::wstring wh = Utf8ToWide(ln);
      WinHttpAddRequestHeaders(hRequest, wh.c_str(), (DWORD)-1L, WINHTTP_ADDREQ_FLAG_ADD);
    }
  }

  if (!WinHttpSetOption(hRequest, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0)) {
    cleanupReq(); return jade_text_create("{\"ok\":false,\"error\":\"set upgrade option failed\"}"); }
  if (!WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
    DWORD e = GetLastError(); cleanupReq();
    return jade_text_create(("{\"ok\":false,\"error\":\"send failed " + std::to_string(e) + WsErrSuffix(e) + "\"}").c_str()); }
  if (!WinHttpReceiveResponse(hRequest, nullptr)) {
    DWORD e = GetLastError(); cleanupReq();
    return jade_text_create(("{\"ok\":false,\"error\":\"recv response failed " + std::to_string(e) + WsErrSuffix(e) + "\"}").c_str()); }

  // 握手 HTTP 状态码：101=Switching Protocols 才是真正升级成功；401/403 等多为鉴权失败
  DWORD wsStatus = 0, wsStatusSize = sizeof(wsStatus);
  WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &wsStatus, &wsStatusSize, nullptr);

  HINTERNET hWebSocket = WinHttpWebSocketCompleteUpgrade(hRequest, 0);
  if (!hWebSocket) { DWORD e = GetLastError(); cleanupReq();
    return jade_text_create(("{\"ok\":false,\"error\":\"upgrade failed " + std::to_string(e) + " (握手返回 HTTP " + std::to_string(wsStatus) + "，非 101/被拒)\",\"status\":" + std::to_string(wsStatus) + "}").c_str()); }
  WinHttpCloseHandle(hRequest); hRequest = nullptr;  // 升级后不再需要请求句柄

  auto conn = std::make_shared<WsBridgeConn>();
  conn->hSession = hSession; conn->hConnect = hConnect; conn->hWebSocket = hWebSocket;
  conn->open = true; conn->state = "open";
  uint32_t id = g_wsBridgeNextId.fetch_add(1);
  { std::lock_guard<std::mutex> lk(g_wsBridgeMtx); g_wsBridge[id] = conn; }

  conn->recvThread = std::thread([conn]() {
    std::string msg;
    std::vector<BYTE> buf(8192);
    while (!conn->stop.load()) {
      DWORD got = 0;
      WINHTTP_WEB_SOCKET_BUFFER_TYPE bt;
      DWORD r = WinHttpWebSocketReceive(conn->hWebSocket, buf.data(), (DWORD)buf.size(), &got, &bt);
      if (r != NO_ERROR) {
        std::lock_guard<std::mutex> lk(conn->mtx);
        conn->state = conn->stop.load() ? "closed" : "error";
        conn->open = false;
        break;
      }
      if (bt == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
        std::lock_guard<std::mutex> lk(conn->mtx);
        conn->state = "closed"; conn->open = false;
        break;
      }
      if (got > 0) msg.append(reinterpret_cast<char*>(buf.data()), got);
      if (bt == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE ||
          bt == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE) {
        std::lock_guard<std::mutex> lk(conn->mtx);
        conn->incoming.push_back(msg);
        msg.clear();
      }
      // *_FRAGMENT_BUFFER_TYPE：分片，继续累积直到收到 MESSAGE 类型
    }
  });

  Log("ws_open id=" + std::to_string(id) + " host=" + WideToUtf8(hostName) + " httpStatus=" + std::to_string(wsStatus));
  return jade_text_create(("{\"ok\":true,\"id\":" + std::to_string(id) + ",\"status\":" + std::to_string(wsStatus) + "}").c_str());
}

const char* JADEVIEW_CALL WsSend(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  uint32_t id = (uint32_t)ParseInteger(JsonStringValue(json, "id"));
  std::string data = JsonStringValue(json, "data");
  auto conn = WsBridgeFind(id);
  if (!conn || !conn->open.load()) return jade_text_create("{\"ok\":false,\"error\":\"not open\"}");
  DWORD r = WinHttpWebSocketSend(conn->hWebSocket, WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
                                 (PVOID)data.data(), (DWORD)data.size());
  if (r == NO_ERROR) return jade_text_create("{\"ok\":true}");
  return jade_text_create(("{\"ok\":false,\"error\":\"send failed " + std::to_string(r) + WsErrSuffix(r) + "\"}").c_str());
}

const char* JADEVIEW_CALL WsPoll(uint32_t, const char* payload) {
  uint32_t id = (uint32_t)ParseInteger(JsonStringValue(payload ? payload : "", "id"));
  auto conn = WsBridgeFind(id);
  if (!conn) return jade_text_create("{\"ok\":false,\"error\":\"no conn\",\"state\":\"closed\",\"messages\":[]}");
  std::string out;
  {
    std::lock_guard<std::mutex> lk(conn->mtx);
    out = "{\"ok\":true,\"state\":\"" + conn->state + "\",\"messages\":[";
    bool first = true;
    while (!conn->incoming.empty()) {
      if (!first) out += ",";
      first = false;
      out += "\"" + JsonEscape(conn->incoming.front()) + "\"";
      conn->incoming.pop_front();
    }
    out += "]}";
  }
  return jade_text_create(out.c_str());
}

const char* JADEVIEW_CALL WsClose(uint32_t, const char* payload) {
  uint32_t id = (uint32_t)ParseInteger(JsonStringValue(payload ? payload : "", "id"));
  std::shared_ptr<WsBridgeConn> conn;
  {
    std::lock_guard<std::mutex> lk(g_wsBridgeMtx);
    auto it = g_wsBridge.find(id);
    if (it != g_wsBridge.end()) { conn = it->second; g_wsBridge.erase(it); }
  }
  if (!conn) return jade_text_create("{\"ok\":true}");
  conn->stop = true;
  // 关闭 WebSocket 句柄会取消另一线程上阻塞中的 WinHttpWebSocketReceive（同步模式下
  // 返回错误），收发线程随即退出。这样避免 WinHttpWebSocketClose 在收发挂起时死锁。
  if (conn->hWebSocket) { WinHttpCloseHandle(conn->hWebSocket); conn->hWebSocket = nullptr; }
  if (conn->recvThread.joinable()) conn->recvThread.join();
  if (conn->hConnect) { WinHttpCloseHandle(conn->hConnect); conn->hConnect = nullptr; }
  if (conn->hSession) { WinHttpCloseHandle(conn->hSession); conn->hSession = nullptr; }
  Log("ws_close id=" + std::to_string(id));
  return jade_text_create("{\"ok\":true}");
}

const char* JADEVIEW_CALL ToggleDevtools(uint32_t window_id, const char*) {
  uint32_t target = window_id ? window_id : g_main_window;
  if (!g_devMode || !target) return jade_text_create("{\"ok\":false}");
  int open = is_devtools_open(target);
  if (open) close_devtools(target); else open_devtools(target);
  Log("devtools " + std::string(open ? "closed" : "opened"));
  return jade_text_create("{\"ok\":true}");
}

// ═══════════════════════════ YOLO 工具原生支持 ═══════════════════════════
#pragma comment(lib, "comdlg32.lib")
namespace yolo {

std::wstring ExeDirW() {
  wchar_t buf[MAX_PATH] = {}; GetModuleFileNameW(nullptr, buf, MAX_PATH);
  std::wstring p = buf; size_t s = p.find_last_of(L"\\/");
  return s == std::wstring::npos ? std::wstring(L".") : p.substr(0, s);
}
std::string B64Encode(const uint8_t* d, size_t n) {
  static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string o; o.reserve((n + 2) / 3 * 4);
  for (size_t i = 0; i < n; i += 3) {
    uint8_t b0 = d[i], b1 = (i + 1 < n) ? d[i + 1] : 0, b2 = (i + 2 < n) ? d[i + 2] : 0;
    o += t[b0 >> 2]; o += t[((b0 & 3) << 4) | (b1 >> 4)];
    o += (i + 1 < n) ? t[((b1 & 15) << 2) | (b2 >> 6)] : '='; o += (i + 2 < n) ? t[b2 & 63] : '=';
  }
  return o;
}
bool ReadAllShared(const std::wstring& path, std::string& out) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  out.clear(); char buf[65536]; DWORD rd = 0;
  while (ReadFile(h, buf, sizeof(buf), &rd, nullptr) && rd > 0) out.append(buf, rd);
  CloseHandle(h); return true;
}
bool ReadBytes(const std::wstring& path, std::vector<uint8_t>& out) {
  std::string s; if (!ReadAllShared(path, s)) return false; out.assign(s.begin(), s.end()); return true;
}
bool WriteAll(const std::wstring& path, const std::string& data) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  DWORD wr = 0; BOOL ok = WriteFile(h, data.data(), (DWORD)data.size(), &wr, nullptr);
  CloseHandle(h); return ok && wr == data.size();
}
std::string MimeOf(const std::wstring& path) {
  std::wstring e; size_t d = path.find_last_of(L'.'); if (d != std::wstring::npos) e = path.substr(d + 1);
  for (auto& c : e) c = towlower(c);
  if (e == L"png") return "image/png"; if (e == L"bmp") return "image/bmp";
  if (e == L"webp") return "image/webp"; if (e == L"gif") return "image/gif";
  return "image/jpeg";
}
std::string UrlEncode(const std::string& s) {
  std::string o; char b[8];
  for (unsigned char c : s) {
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || c == '/' || c == ':' || c == '\\') o += c;
    else { snprintf(b, sizeof(b), "%%%02X", c); o += b; }
  }
  return o;
}
std::string Ftos(double v, int prec) { std::ostringstream o; o << std::fixed << std::setprecision(prec) << v; return o.str(); }

// ── 文件/文件夹对话框 ──
const char* JADEVIEW_CALL PickFile(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string filter = JsonStringValue(json, "filter");
  std::wstring initialDir = Utf8ToWide(JsonStringValue(json, "initialDir"));
  if (filter.empty()) filter = "所有文件 (*.*)|*.*";
  std::wstring fw = Utf8ToWide(filter), wf;
  for (wchar_t c : fw) wf.push_back(c == L'|' ? L'\0' : c);
  wf.push_back(L'\0'); wf.push_back(L'\0');
  wchar_t file[2048] = {};
  OPENFILENAMEW ofn = {}; ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = g_main_window ? (HWND)get_window_hwnd(g_main_window) : nullptr;
  ofn.lpstrFilter = wf.c_str(); ofn.lpstrFile = file; ofn.nMaxFile = 2048;
  ofn.lpstrInitialDir = initialDir.empty() ? nullptr : initialDir.c_str();
  ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_EXPLORER;
  if (GetOpenFileNameW(&ofn))
    return jade_text_create((std::string("{\"ok\":true,\"path\":\"") + JsonEscape(WideToUtf8(file)) + "\"}").c_str());
  return jade_text_create("{\"ok\":false}");
}
const char* JADEVIEW_CALL PickDir(uint32_t, const char* payload) {
  std::string result = "{\"ok\":false}";
  std::string json = payload ? payload : "";
  std::wstring initialDir = Utf8ToWide(JsonStringValue(json, "initialDir"));
  HRESULT hrInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  IFileDialog* pfd = nullptr;
  if (SUCCEEDED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&pfd)))) {
    DWORD opts = 0; pfd->GetOptions(&opts); pfd->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
    if (!initialDir.empty()) {
      IShellItem* folder = nullptr;
      if (SUCCEEDED(SHCreateItemFromParsingName(initialDir.c_str(), nullptr, IID_PPV_ARGS(&folder)))) {
        pfd->SetFolder(folder);
        folder->Release();
      }
    }
    HWND owner = g_main_window ? (HWND)get_window_hwnd(g_main_window) : nullptr;
    if (SUCCEEDED(pfd->Show(owner))) {
      IShellItem* item = nullptr;
      if (SUCCEEDED(pfd->GetResult(&item))) {
        PWSTR path = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) {
          result = "{\"ok\":true,\"path\":\"" + JsonEscape(WideToUtf8(path)) + "\"}";
          CoTaskMemFree(path);
        }
        item->Release();
      }
    }
    pfd->Release();
  }
  if (hrInit == S_OK) CoUninitialize();
  return jade_text_create(result.c_str());
}

// ── 列图片 / 读图 / 读写文本 ──
const char* JADEVIEW_CALL ListImages(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::wstring dir = Utf8ToWide(JsonStringValue(json, "dir"));
  if (dir.empty()) return jade_text_create("{\"ok\":false,\"error\":\"no dir\"}");
  std::wstring base = dir; if (base.back() != L'\\' && base.back() != L'/') base += L"\\";
  std::string out = "{\"ok\":true,\"images\":["; bool first = true;
  WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((base + L"*").c_str(), &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
      std::wstring name = fd.cFileName, ext; size_t d = name.find_last_of(L'.');
      if (d != std::wstring::npos) { ext = name.substr(d + 1); for (auto& c : ext) c = towlower(c); }
      if (ext != L"jpg" && ext != L"jpeg" && ext != L"png" && ext != L"bmp" && ext != L"webp") continue;
      std::wstring full = base + name;
      std::wstring lbl = full.substr(0, full.find_last_of(L'.')) + L".txt";
      int count = 0; bool has = false; std::string txt;
      if (ReadAllShared(lbl, txt)) { has = true; std::stringstream ss(txt); std::string ln;
        while (std::getline(ss, ln)) if (ln.find_first_not_of(" \t\r\n") != std::string::npos) count++; }
      if (!first) out += ","; first = false;
      out += "{\"name\":\"" + JsonEscape(WideToUtf8(name)) + "\",\"path\":\"" + JsonEscape(WideToUtf8(full)) +
             "\",\"hasLabel\":" + (has ? "true" : "false") + ",\"count\":" + std::to_string(count) + "}";
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  out += "]}";
  return jade_text_create(out.c_str());
}
const char* JADEVIEW_CALL ReadImage(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::wstring path = Utf8ToWide(JsonStringValue(json, "path"));
  std::vector<uint8_t> bytes; if (!ReadBytes(path, bytes)) return jade_text_create("{\"ok\":false,\"error\":\"read failed\"}");
  UINT w = 0, h = 0;
  { Gdiplus::Bitmap bmp(path.c_str()); if (bmp.GetLastStatus() == Gdiplus::Ok) { w = bmp.GetWidth(); h = bmp.GetHeight(); } }
  std::string data = "data:" + MimeOf(path) + ";base64," + B64Encode(bytes.data(), bytes.size());
  std::string out = "{\"ok\":true,\"w\":" + std::to_string(w) + ",\"h\":" + std::to_string(h) + ",\"data\":\"" + data + "\"}";
  return jade_text_create(out.c_str());
}
const char* JADEVIEW_CALL ReadText(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::wstring path = Utf8ToWide(JsonStringValue(json, "path"));
  std::string txt;
  if (!ReadAllShared(path, txt)) return jade_text_create("{\"ok\":true,\"exists\":false,\"text\":\"\"}");
  return jade_text_create((std::string("{\"ok\":true,\"exists\":true,\"text\":\"") + JsonEscape(txt) + "\"}").c_str());
}
const char* JADEVIEW_CALL WriteText(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::wstring path = Utf8ToWide(JsonStringValue(json, "path"));
  std::string text = JsonStringValue(json, "text");
  size_t sl = path.find_last_of(L"\\/");
  if (sl != std::wstring::npos) SHCreateDirectoryExW(nullptr, path.substr(0, sl).c_str(), nullptr);
  bool ok = WriteAll(path, text);
  return jade_text_create(ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"write failed\"}");
}
const char* JADEVIEW_CALL EnvDetect(uint32_t, const char*) {
  auto getenvw = [](const wchar_t* k) -> std::wstring {
    wchar_t buf[MAX_PATH] = {}; DWORD n = GetEnvironmentVariableW(k, buf, MAX_PATH); return n ? std::wstring(buf, n) : std::wstring();
  };
  std::string py, y5;
  std::wstring la = getenvw(L"LOCALAPPDATA");
  std::vector<std::wstring> pyc;
  if (!la.empty()) for (auto v : { L"311", L"312", L"310", L"313", L"39" })
    pyc.push_back(la + L"\\Programs\\Python\\Python" + v + L"\\python.exe");
  for (auto& c : pyc) if (GetFileAttributesW(c.c_str()) != INVALID_FILE_ATTRIBUTES) { py = WideToUtf8(c); break; }
  std::wstring up = getenvw(L"USERPROFILE");
  std::vector<std::wstring> yc;
  if (!up.empty()) { yc.push_back(up + L"\\Desktop\\yolo\\yolov5-7.0"); yc.push_back(up + L"\\Desktop\\yolov5"); yc.push_back(up + L"\\yolov5"); }
  yc.push_back(L"D:\\yolo\\yolov5-7.0"); yc.push_back(L"D:\\yolov5"); yc.push_back(L"C:\\yolov5");
  for (auto& c : yc) if (GetFileAttributesW((c + L"\\train.py").c_str()) != INVALID_FILE_ATTRIBUTES) { y5 = WideToUtf8(c); break; }
  return jade_text_create(("{\"ok\":true,\"python\":\"" + JsonEscape(py) + "\",\"yolov5\":\"" + JsonEscape(y5) + "\"}").c_str());
}

// ── 训练：子进程 + Job（整树可杀） + results.csv 解析 ──
std::mutex g_trainMx;
std::string g_trainLog;
HANDLE g_trainProc = nullptr;
HANDLE g_trainJob = nullptr;
std::thread g_trainReader;
std::atomic<int> g_trainExit{ -1 };
std::atomic<bool> g_trainRunning{ false };

void TrainReaderFn(HANDLE rd) {
  char buf[8192]; DWORD n = 0;
  while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) {
    std::lock_guard<std::mutex> lk(g_trainMx);
    g_trainLog.append(buf, n);
    if (g_trainLog.size() > 400000) g_trainLog.erase(0, g_trainLog.size() - 350000);
  }
  CloseHandle(rd);
}
void TrainStopInternal() {
  if (g_trainJob) { CloseHandle(g_trainJob); g_trainJob = nullptr; }  // KILL_ON_JOB_CLOSE 杀整树
  if (g_trainReader.joinable()) g_trainReader.join();
  if (g_trainProc) { CloseHandle(g_trainProc); g_trainProc = nullptr; }
  g_trainRunning = false;
}
// 通用：起一个被 Job 包裹（可整树杀）、stdout/err 汇入 g_trainLog 的后台进程
bool StartJob(const std::string& cmd, const std::wstring& wcwd) {
  TrainStopInternal();
  SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, TRUE };
  HANDLE rd = nullptr, wr = nullptr;
  if (!CreatePipe(&rd, &wr, &sa, 0)) return false;
  SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
  STARTUPINFOW si = {}; si.cb = sizeof(si); si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = wr; si.hStdError = wr; si.hStdInput = nullptr;
  PROCESS_INFORMATION pi = {};
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jli = {}; jli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jli, sizeof(jli));
  std::wstring wcmd = Utf8ToWide(cmd); std::vector<wchar_t> cmdBuf(wcmd.begin(), wcmd.end()); cmdBuf.push_back(0);
  std::wstring envBlock;
  { LPWCH ev = GetEnvironmentStringsW();
    for (LPWCH p = ev; *p; ) { std::wstring e = p;
      if (e.rfind(L"PYTHONIOENCODING=", 0) != 0 && e.rfind(L"PYTHONUNBUFFERED=", 0) != 0) { envBlock += e; envBlock.push_back(0); }
      p += e.size() + 1; }
    FreeEnvironmentStringsW(ev);
    envBlock += L"PYTHONIOENCODING=utf-8"; envBlock.push_back(0);
    envBlock += L"PYTHONUNBUFFERED=1"; envBlock.push_back(0); envBlock.push_back(0);
  }
  BOOL ok = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                           (LPVOID)envBlock.data(), wcwd.empty() ? nullptr : wcwd.c_str(), &si, &pi);
  CloseHandle(wr);
  if (!ok) { CloseHandle(rd); CloseHandle(job); return false; }
  AssignProcessToJobObject(job, pi.hProcess);
  ResumeThread(pi.hThread); CloseHandle(pi.hThread);
  { std::lock_guard<std::mutex> lk(g_trainMx); g_trainLog.clear(); }
  g_trainProc = pi.hProcess; g_trainJob = job; g_trainExit = -1; g_trainRunning = true;
  g_trainReader = std::thread(TrainReaderFn, rd);
  return true;
}
// 训练：前端拼好完整命令行（区分 v5 train.py / v8 ultralytics），native 只负责起进程 + 流式
const char* JADEVIEW_CALL TrainStart(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string cmd = JsonStringValue(json, "cmd");
  std::string cwd = JsonStringValue(json, "cwd");
  if (cmd.empty()) return jade_text_create("{\"ok\":false,\"error\":\"no cmd\"}");
  if (!StartJob(cmd, Utf8ToWide(cwd))) return jade_text_create("{\"ok\":false,\"error\":\"启动失败\"}");
  return jade_text_create("{\"ok\":true}");
}
// 缺依赖时 pip 安装（流式，前端复用 train_poll 显示进度）
const char* JADEVIEW_CALL PyInstall(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string python = JsonStringValue(json, "python");
  std::string pkg = JsonStringValue(json, "pkg"); if (pkg.empty()) pkg = "ultralytics";
  if (python.empty()) return jade_text_create("{\"ok\":false,\"error\":\"no python\"}");
  std::string cmd = "\"" + python + "\" -m pip install --upgrade " + pkg;
  if (!StartJob(cmd, L"")) return jade_text_create("{\"ok\":false,\"error\":\"启动失败\"}");
  return jade_text_create("{\"ok\":true}");
}
std::wstring FindRunDir(const std::string& cwd, const std::string& project, const std::string& name) {
  std::wstring base = Utf8ToWide(cwd); if (!base.empty() && base.back() != L'\\') base += L"\\";
  base += Utf8ToWide(project.empty() ? "runs/train" : project);
  for (auto& c : base) if (c == L'/') c = L'\\';
  std::wstring exact = base + L"\\" + Utf8ToWide(name.empty() ? "exp" : name);
  std::wstring bestDir; FILETIME best = {};
  WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW((base + L"\\" + Utf8ToWide(name.empty() ? "exp" : name) + L"*").c_str(), &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
      if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
      if (CompareFileTime(&fd.ftLastWriteTime, &best) >= 0) { best = fd.ftLastWriteTime; bestDir = base + L"\\" + fd.cFileName; }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  return bestDir.empty() ? exact : bestDir;
}
std::string ParseResultsCsv(const std::string& cwd, const std::string& project, const std::string& name) {
  std::wstring dir = FindRunDir(cwd, project, name);
  std::string txt; if (!ReadAllShared(dir + L"\\results.csv", txt)) return "[]";
  std::vector<std::string> lines; { std::stringstream ss(txt); std::string ln;
    while (std::getline(ss, ln)) { if (!ln.empty() && ln.back() == '\r') ln.pop_back();
      if (ln.find_first_not_of(" \t") != std::string::npos) lines.push_back(ln); } }
  if (lines.size() < 2) return "[]";
  auto trim = [](std::string c) { size_t a = c.find_first_not_of(" \t"); size_t b = c.find_last_not_of(" \t");
    return a == std::string::npos ? std::string() : c.substr(a, b - a + 1); };
  std::vector<std::string> keys; { std::stringstream hs(lines[0]); std::string cell;
    while (std::getline(hs, cell, ',')) { cell = trim(cell); if (cell.rfind("metrics/", 0) == 0) cell = cell.substr(8); keys.push_back(cell); } }
  std::string out = "[";
  for (size_t li = 1; li < lines.size(); ++li) {
    std::stringstream rs(lines[li]); std::string cell; size_t ci = 0; std::string obj = "{"; bool f = true;
    while (std::getline(rs, cell, ',')) {
      cell = trim(cell);
      if (ci < keys.size() && !keys[ci].empty()) {
        if (!f) obj += ","; f = false;
        obj += "\"" + JsonEscape(keys[ci]) + "\":";
        char* end = nullptr; strtod(cell.c_str(), &end);
        if (!cell.empty() && end && *end == '\0') obj += cell; else obj += "\"" + JsonEscape(cell) + "\"";
      }
      ci++;
    }
    obj += "}"; if (li > 1) out += ","; out += obj;
  }
  out += "]"; return out;
}
const char* JADEVIEW_CALL TrainPoll(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string cwd = JsonStringValue(json, "cwd");
  std::string project = JsonStringValue(json, "project");
  std::string name = JsonStringValue(json, "name");
  bool running = g_trainRunning.load(); int exitCode = g_trainExit.load();
  if (running && g_trainProc) {
    DWORD code = 0;
    if (GetExitCodeProcess(g_trainProc, &code) && code != STILL_ACTIVE) {
      running = false; exitCode = (int)code; g_trainExit = (int)code;
      if (g_trainReader.joinable()) g_trainReader.join();
      if (g_trainJob) { CloseHandle(g_trainJob); g_trainJob = nullptr; }
      CloseHandle(g_trainProc); g_trainProc = nullptr; g_trainRunning = false;
    }
  }
  std::string log; { std::lock_guard<std::mutex> lk(g_trainMx); log = g_trainLog; }
  std::string csv = ParseResultsCsv(cwd, project, name);
  std::string out = "{\"ok\":true,\"running\":" + std::string(running ? "true" : "false") +
                    ",\"exitCode\":" + std::to_string(exitCode) +
                    ",\"log\":\"" + JsonEscape(log) + "\",\"csv\":" + csv + "}";
  return jade_text_create(out.c_str());
}
const char* JADEVIEW_CALL TrainStop(uint32_t, const char*) { TrainStopInternal(); return jade_text_create("{\"ok\":true}"); }

// ── 同步捕获子进程 stdout（供 Python 一次性调用：检测/依赖检查/环境探测）──
bool RunCapture(const std::wstring& cmdline, const std::wstring& cwd, DWORD timeoutMs, std::string& out) {
  SECURITY_ATTRIBUTES sa = { sizeof(sa), nullptr, TRUE };
  HANDLE rd = nullptr, wr = nullptr;
  if (!CreatePipe(&rd, &wr, &sa, 0)) return false;
  SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
  STARTUPINFOW si = {}; si.cb = sizeof(si); si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = wr; si.hStdError = wr; si.hStdInput = nullptr;
  PROCESS_INFORMATION pi = {};
  std::vector<wchar_t> cb(cmdline.begin(), cmdline.end()); cb.push_back(0);
  std::wstring env;
  { LPWCH ev = GetEnvironmentStringsW();
    for (LPWCH p = ev; *p; ) { std::wstring e = p;
      if (e.rfind(L"PYTHONIOENCODING=", 0) != 0 && e.rfind(L"PYTHONUNBUFFERED=", 0) != 0) { env += e; env.push_back(0); }
      p += e.size() + 1; }
    FreeEnvironmentStringsW(ev);
    env += L"PYTHONIOENCODING=utf-8"; env.push_back(0);
    env += L"PYTHONUNBUFFERED=1"; env.push_back(0); env.push_back(0); }
  BOOL ok = CreateProcessW(nullptr, cb.data(), nullptr, nullptr, TRUE,
                           CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                           (LPVOID)env.data(), cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  CloseHandle(wr);
  if (!ok) { CloseHandle(rd); return false; }
  out.clear(); char buf[8192]; DWORD n = 0; DWORD start = GetTickCount();
  for (;;) {
    DWORD avail = 0;
    if (PeekNamedPipe(rd, nullptr, 0, nullptr, &avail, nullptr) && avail > 0) {
      if (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) { out.append(buf, n); continue; }
    }
    if (WaitForSingleObject(pi.hProcess, 30) == WAIT_OBJECT_0) {
      while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) out.append(buf, n);
      break;
    }
    if (timeoutMs && GetTickCount() - start > timeoutMs) { TerminateProcess(pi.hProcess, 1); break; }
  }
  CloseHandle(rd); CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  return true;
}
// 从捕获输出里取 "JADE_RESULT:" 之后到行尾的 JSON
std::string ExtractResult(const std::string& s) {
  size_t p = s.rfind("JADE_RESULT:");
  if (p == std::string::npos) return "";
  size_t b = p + 12; size_t e = s.find_first_of("\r\n", b);
  return s.substr(b, e == std::string::npos ? std::string::npos : e - b);
}
std::wstring DataDirW() { std::wstring d = ExeDirW() + L"\\data"; SHCreateDirectoryExW(nullptr, d.c_str(), nullptr); return d; }

// ── Python 推理（ultralytics，支持 .pt/.onnx，v5/v8/v11…；自动 GPU/CPU）──
const char* JADEVIEW_CALL Infer(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string python = JsonStringValue(json, "python");
  std::string model = JsonStringValue(json, "model");
  std::string image = JsonStringValue(json, "image");
  std::string conf = JsonStringValue(json, "conf"); if (conf.empty()) conf = "0.25";
  std::string iou = JsonStringValue(json, "iou"); if (iou.empty()) iou = "0.45";
  if (python.empty()) return jade_text_create("{\"ok\":false,\"error\":\"未指定 Python 解释器\"}");
  // 推理脚本
  std::string py =
    "import sys, json\n"
    "try:\n"
    "    from ultralytics import YOLO\n"
    "    import torch\n"
    "    model_path = sys.argv[1].lower()\n"
    "    is_onnx = model_path.endswith('.onnx')\n"
    "    m = YOLO(sys.argv[1])\n"
    "    device = 'cpu' if is_onnx else (0 if torch.cuda.is_available() else 'cpu')\n"
    "    r = m.predict(sys.argv[2], conf=float(sys.argv[3]), iou=float(sys.argv[4]), device=device, verbose=False)[0]\n"
    "    H, W = int(r.orig_shape[0]), int(r.orig_shape[1])\n"
    "    nm = r.names\n"
    "    dets = []\n"
    "    for b in r.boxes:\n"
    "        x1,y1,x2,y2 = [float(v) for v in b.xyxy[0].tolist()]\n"
    "        dets.append({\"cls\":int(b.cls[0]),\"conf\":float(b.conf[0]),\"x\":x1,\"y\":y1,\"w\":x2-x1,\"h\":y2-y1})\n"
    "    ep = (\"CPU \\u00b7 ONNX 兼容模式\" if is_onnx else ((\"GPU \\u00b7 \"+torch.cuda.get_device_name(0)) if torch.cuda.is_available() else \"CPU\"))\n"
    "    out = {\"ok\":True,\"w\":W,\"h\":H,\"dets\":dets,\"names\":[nm[i] for i in sorted(nm)],\"ep\":ep}\n"
    "except Exception as e:\n"
    "    out = {\"ok\":False,\"error\":str(e)}\n"
    "print(\"JADE_RESULT:\"+json.dumps(out))\n";
  std::string modelLower = model;
  std::transform(modelLower.begin(), modelLower.end(), modelLower.begin(), [](unsigned char c){ return (char)std::tolower(c); });
  bool isOnnx = modelLower.size() >= 5 && modelLower.substr(modelLower.size() - 5) == ".onnx";
  if (isOnnx) {
    py =
      "import sys,json,ast,time\n"
      "try:\n"
      " import cv2,numpy as np,onnxruntime as ort\n"
      " t0=time.perf_counter(); model_path,img_path=sys.argv[1],sys.argv[2]; conf=float(sys.argv[3]); iou=float(sys.argv[4])\n"
      " im=cv2.imread(img_path)\n"
      " if im is None: raise RuntimeError('image read failed')\n"
      " H,W=im.shape[:2]; s=min(640.0/W,640.0/H); nw,nh=round(W*s),round(H*s)\n"
      " rs=cv2.resize(im,(nw,nh),interpolation=cv2.INTER_LINEAR); canvas=np.full((640,640,3),114,dtype=np.uint8); px=(640-nw)//2; py=(640-nh)//2; canvas[py:py+nh,px:px+nw]=rs\n"
      " blob=canvas[:,:,::-1].transpose(2,0,1)[None].astype(np.float32)/255.0\n"
      " sess=ort.InferenceSession(model_path,providers=['CPUExecutionProvider']); t1=time.perf_counter(); inp=sess.get_inputs()[0]; out=sess.run(None,{inp.name:blob})[0]; t2=time.perf_counter()\n"
      " a=np.asarray(out); a=a[0] if a.ndim==3 else a; a=a.T if a.ndim==2 and a.shape[0]<a.shape[1] else a\n"
      " names=['A']; raw_names=sess.get_modelmeta().custom_metadata_map.get('names','')\n"
      " try:\n"
      "  z=ast.literal_eval(raw_names); names=[z[k] for k in sorted(z)] if isinstance(z,dict) else list(z)\n"
      " except Exception: pass\n"
      " boxes=[]\n"
      " for v in a:\n"
      "  if len(v)<6: continue\n"
      "  score=float(v[4])\n"
      "  if score<conf: continue\n"
      "  cls=0 if len(names)<=1 else int(round(float(v[5])))\n"
      "  cx,cy,bw,bh=[float(q) for q in v[:4]]; x1=(cx-bw/2-px)/s; y1=(cy-bh/2-py)/s; x2=(cx+bw/2-px)/s; y2=(cy+bh/2-py)/s\n"
      "  x1=max(0,min(W,x1)); y1=max(0,min(H,y1)); x2=max(0,min(W,x2)); y2=max(0,min(H,y2))\n"
      "  if x2>x1 and y2>y1: boxes.append([x1,y1,x2,y2,score,cls])\n"
      " keep=[]\n"
      " for c in sorted(set(int(v[5]) for v in boxes)):\n"
      "  q=[v for v in boxes if int(v[5])==c]; q.sort(key=lambda v:v[4],reverse=True)\n"
      "  while q:\n"
      "   v=q.pop(0); keep.append(v); ax,ay,ab,ad=v[:4]; rem=[]\n"
      "   for u in q:\n"
      "    ix=max(0,min(ab,u[2])-max(ax,u[0])); iy=max(0,min(ad,u[3])-max(ay,u[1])); inter=ix*iy; uni=(ab-ax)*(ad-ay)+(u[2]-u[0])*(u[3]-u[1])-inter\n"
      "    if inter/max(uni,1e-6)<=iou: rem.append(u)\n"
      "   q=rem\n"
      " dets=[{'cls':int(v[5]),'conf':float(v[4]),'x':float(v[0]),'y':float(v[1]),'w':float(v[2]-v[0]),'h':float(v[3]-v[1])} for v in keep]\n"
      " out={'ok':True,'w':W,'h':H,'dets':dets,'names':names,'ep':'CPU ONNX Runtime','inferMs':(t2-t1)*1000,'ms':(time.perf_counter()-t0)*1000}\n"
      "except Exception as e: out={'ok':False,'error':str(e)}\n"
      "print('JADE_RESULT:'+json.dumps(out,ensure_ascii=False))\n";
  }
  std::wstring scriptPath = DataDirW() + L"\\_yolo_infer.py";
  WriteAll(scriptPath, py);
  std::wstring cmd = L"\"" + Utf8ToWide(python) + L"\" \"" + scriptPath + L"\" \"" + Utf8ToWide(model) +
                     L"\" \"" + Utf8ToWide(image) + L"\" " + Utf8ToWide(conf) + L" " + Utf8ToWide(iou);
  ULONGLONG captureStart = GetTickCount64();
  std::string raw;
  if (!RunCapture(cmd, L"", 300000, raw)) return jade_text_create("{\"ok\":false,\"error\":\"无法启动 Python\"}");
  std::string res = ExtractResult(raw);
  if (res.empty()) {
    std::string tail = raw.size() > 600 ? raw.substr(raw.size() - 600) : raw;
    return jade_text_create((std::string("{\"ok\":false,\"error\":\"Python 推理无结果，可能缺 ultralytics/torch\",\"detail\":\"") + JsonEscape(tail) + "\"}").c_str());
  }
  size_t objEnd = res.rfind('}');
  if (objEnd != std::string::npos && res.find("\"totalMs\"") == std::string::npos)
    res.insert(objEnd, ",\"totalMs\":" + std::to_string((double)(GetTickCount64() - captureStart)));
  // 补 imgData（原图 base64）到结果 JSON 末尾
  std::vector<uint8_t> ib; ReadBytes(Utf8ToWide(image), ib);
  std::string imgData = "data:" + MimeOf(Utf8ToWide(image)) + ";base64," + B64Encode(ib.data(), ib.size());
  size_t lb = res.rfind('}');
  if (lb != std::string::npos) res.insert(lb, ",\"imgData\":\"" + imgData + "\"");
  return jade_text_create(res.c_str());
}

// ── Python 多方法自动检测 ──
void AddPy(std::vector<std::wstring>& v, const std::wstring& p) {
  if (p.empty() || GetFileAttributesW(p.c_str()) == INVALID_FILE_ATTRIBUTES) return;
  for (auto& e : v) if (_wcsicmp(e.c_str(), p.c_str()) == 0) return;
  v.push_back(p);
}
const char* JADEVIEW_CALL PyDetect(uint32_t, const char*) {
  std::vector<std::wstring> cands;
  auto getenvw = [](const wchar_t* k) { wchar_t b[512] = {}; DWORD n = GetEnvironmentVariableW(k, b, 512); return n ? std::wstring(b, n) : std::wstring(); };
  // 1) where python / python3
  for (auto exe : { L"python", L"python3" }) {
    std::string o;
    if (RunCapture(std::wstring(L"cmd /c where ") + exe, L"", 8000, o)) {
      std::stringstream ss(o); std::string ln;
      while (std::getline(ss, ln)) { while (!ln.empty() && (ln.back() == '\r' || ln.back() == '\n' || ln.back() == ' ')) ln.pop_back();
        if (ln.size() > 3) AddPy(cands, Utf8ToWide(ln)); }
    }
  }
  // 2) py 启动器
  { std::string o;
    if (RunCapture(L"cmd /c py -0p", L"", 8000, o)) {
      std::stringstream ss(o); std::string ln;
      while (std::getline(ss, ln)) { size_t e = ln.find("python.exe");
        if (e != std::string::npos) { std::string pe = ln.substr(0, e + 10); size_t s = pe.find_first_of("CDEFGdefg:"); size_t d = pe.find(":\\");
          if (d != std::string::npos && d >= 1) { pe = pe.substr(d - 1); AddPy(cands, Utf8ToWide(pe)); } } }
    }
  }
  // 3) 常见安装路径
  std::wstring la = getenvw(L"LOCALAPPDATA"), pf = getenvw(L"ProgramFiles");
  for (auto v : { L"313", L"312", L"311", L"310", L"39" }) {
    if (!la.empty()) AddPy(cands, la + L"\\Programs\\Python\\Python" + v + L"\\python.exe");
    AddPy(cands, std::wstring(L"C:\\Python") + v + L"\\python.exe");
    if (!pf.empty()) AddPy(cands, pf + L"\\Python" + v + L"\\python.exe");
  }
  // 4) 注册表 PythonCore
  for (HKEY root : { HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE }) {
    HKEY h;
    if (RegOpenKeyExW(root, L"SOFTWARE\\Python\\PythonCore", 0, KEY_READ, &h) == ERROR_SUCCESS) {
      wchar_t sub[256]; DWORD idx = 0, sz = 256;
      while (RegEnumKeyExW(h, idx++, sub, &sz, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS) {
        sz = 256; std::wstring ip = std::wstring(L"SOFTWARE\\Python\\PythonCore\\") + sub + L"\\InstallPath";
        HKEY h2;
        if (RegOpenKeyExW(root, ip.c_str(), 0, KEY_READ, &h2) == ERROR_SUCCESS) {
          wchar_t val[512] = {}; DWORD vs = sizeof(val);
          if (RegQueryValueExW(h2, nullptr, nullptr, nullptr, (LPBYTE)val, &vs) == ERROR_SUCCESS) {
            std::wstring d = val; if (!d.empty() && d.back() != L'\\') d += L"\\"; AddPy(cands, d + L"python.exe"); }
          RegCloseKey(h2);
        }
      }
      RegCloseKey(h);
    }
  }
  // 查版本
  std::string arr = "["; bool first = true;
  for (auto& p : cands) {
    std::string o, ver;
    if (RunCapture(L"\"" + p + L"\" --version", L"", 8000, o)) {
      size_t q = o.find("Python"); if (q != std::string::npos) { ver = o.substr(q); while (!ver.empty() && (ver.back() == '\r' || ver.back() == '\n')) ver.pop_back(); }
    }
    if (!first) arr += ","; first = false;
    arr += "{\"path\":\"" + JsonEscape(WideToUtf8(p)) + "\",\"version\":\"" + JsonEscape(ver) + "\"}";
  }
  arr += "]";
  return jade_text_create(("{\"ok\":true,\"pythons\":" + arr + "}").c_str());
}
// ── 依赖检查：torch / ultralytics / CUDA ──
const char* JADEVIEW_CALL PyCheck(uint32_t, const char* payload) {
  std::string python = JsonStringValue(payload ? payload : "", "python");
  if (python.empty()) return jade_text_create("{\"ok\":false,\"error\":\"no python\"}");
  std::string py =
    "import json\n"
    "r={\"torch\":False,\"ultralytics\":False,\"cuda\":False,\"gpu\":\"\",\"tver\":\"\",\"uver\":\"\"}\n"
    "try:\n"
    "    import torch\n"
    "    r[\"torch\"]=True; r[\"tver\"]=torch.__version__\n"
    "    if torch.cuda.is_available():\n"
    "        r[\"cuda\"]=True; r[\"gpu\"]=torch.cuda.get_device_name(0)\n"
    "except Exception:\n"
    "    pass\n"
    "try:\n"
    "    import ultralytics\n"
    "    r[\"ultralytics\"]=True; r[\"uver\"]=ultralytics.__version__\n"
    "except Exception:\n"
    "    pass\n"
    "print(\"JADE_RESULT:\"+json.dumps(r))\n";
  std::wstring sp = DataDirW() + L"\\_yolo_check.py";
  WriteAll(sp, py);
  std::string raw;
  if (!RunCapture(L"\"" + Utf8ToWide(python) + L"\" \"" + sp + L"\"", L"", 30000, raw))
    return jade_text_create("{\"ok\":false,\"error\":\"无法启动 Python\"}");
  std::string res = ExtractResult(raw);
  if (res.empty()) return jade_text_create("{\"ok\":false,\"error\":\"Python 执行失败\"}");
  res.insert(1, "\"ok\":true,");   // 在最外层 { 后插入 ok:true
  return jade_text_create(res.c_str());
}

// ── 打开标注独立窗口（原生标题栏，避免自定义 window_control 误控主窗口）──
const char* JADEVIEW_CALL OpenAnnotator(uint32_t, const char* payload) {
  std::string json = payload ? payload : "";
  std::string dir = JsonStringValue(json, "dir");
  std::string url = g_index_url;
  size_t p = url.find("index.html");
  if (p != std::string::npos) url = url.substr(0, p) + "annotator.html";
  else { if (!url.empty() && url.back() != '/') url += "/"; url += "annotator.html"; }
  if (!dir.empty()) url += "?dir=" + UrlEncode(dir);
  WebViewSettings settings = {}; settings.allow_right_click = g_devMode ? 1 : 0; settings.background_throttling = 0;
  if (!g_devMode) settings.preload_js =
    "document.addEventListener('keydown',function(e){if(e.key==='F5'||(e.ctrlKey&&e.key==='r')){e.preventDefault();e.stopPropagation();}},true);";
  WebViewWindowOptions options = {};
  options.title = "YOLO 标注工作台"; options.width = 1280; options.height = 820;
  options.resizable = 1; options.maximizable = 1; options.minimizable = 1;
  options.frame_style = "normal"; options.min_width = 900; options.min_height = 560;
  options.focus = 1; options.use_page_icon = 1;
  uint32_t win = create_webview_window(url.c_str(), 0, &options, &settings);
  return jade_text_create(win ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"create window failed\"}");
}

}  // namespace yolo

const char* JADEVIEW_CALL CreateMainWindow(uint32_t, const char*) {
  if (g_main_window) return jade_text_create("{}");
  Log("app-ready: creating main window");
  DbgLog(std::string("APP_READY: creating main window devmode=") + std::to_string(g_devMode));

  WebViewSettings settings = {};
  settings.allow_right_click = g_devMode ? 1 : 0;  // 开发可右键调试，发布禁
  settings.background_throttling = 1;
  settings.autofill = 0;
  settings.focused = 0;
  // 发布模式：注入JS禁用F5/Ctrl+R防止误刷新
  if (!g_devMode) {
    settings.preload_js = "document.addEventListener('keydown',function(e){if(e.key==='F5'||e.keyCode===116||(e.ctrlKey&&e.key==='r')){e.preventDefault();e.stopPropagation();}},true);";
  }

  WebViewWindowOptions options = {};
  options.title = "Jade Programmer Assistant";
  options.width = 1200;
  options.height = 850;
  options.resizable = 1;
  options.frame_style = "no-titlebar";
  options.transparent = 1;
  options.background_color = "#00000000";
  options.theme = "Dark";
  options.maximizable = 1;
  options.minimizable = 1;
  options.x = 120;
  options.y = 80;
  options.min_width = 940;
  options.min_height = 620;
  options.focus = 1;
  options.use_page_icon = 1;
  options.hide_window = 1;  // ★ 创建即隐藏，等前端加载完成(OnWebViewLoad)再显示，彻底消除启动白闪/多次闪烁 ★

  g_main_window = create_webview_window(g_index_url.c_str(), 0, &options, &settings);
  Log("app-ready: create_webview_window id=" + std::to_string(g_main_window));
  if (g_main_window) {
    // ★ 立即隐藏窗口防止白色闪烁（OnWebViewLoad 时才显示）★
    HWND mh = (HWND)get_window_hwnd(g_main_window);
    if(mh) ShowWindow(mh, SW_HIDE);
    Log("app-ready: set_window_title result=" + std::to_string(set_window_title(g_main_window, "Jade 编程助手 version 1.3")));
    Log("app-ready: set_window_size result=" + std::to_string(set_window_size(g_main_window, 1200, 850)));
    Log("app-ready: set_window_position result=" + std::to_string(set_window_position(g_main_window, 120, 80)));
    SetWindowSubclass(mh, MainWindowSubclassProc, 1, 0);  // 尺寸/DPI 变化时持续重算圆角窗口区域
    ApplyWindowRoundedCorners(mh);
    Log("app-ready: window hidden until WEBVIEW_DID_FINISH_LOAD");
  }
  return jade_text_create("{}");
}
}  // namespace

bool IsDeveloperMode() {
  
#ifdef RELEASE_BUILD
  return false;  // 发布：JAPK 内存资源
#else
  return true;   // 开发：本地 web/ 目录
#endif
}

// ══════════ 清理 WebView2 子进程 ══════════
void KillWebView2Children() {
  DWORD myPid = GetCurrentProcessId();

  // 动态加载 NtQueryInformationProcess (ntdll)
  typedef LONG NTSTATUS;
  typedef struct _PROCESS_BASIC_INFORMATION {
    NTSTATUS ExitStatus;
    PVOID PebBaseAddress;
    ULONG_PTR AffinityMask;
    LONG BasePriority;
    ULONG_PTR UniqueProcessId;
    ULONG_PTR InheritedFromUniqueProcessId;
  } PROCESS_BASIC_INFORMATION;

  typedef NTSTATUS (NTAPI *pfnNtQIP)(HANDLE, ULONG, PVOID, ULONG, PULONG);
  auto NtQIP = (pfnNtQIP)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
  if (!NtQIP) {
    Log("KillWebView2Children: NtQueryInformationProcess not available");
    return;
  }

  std::vector<DWORD> childPids;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return;

  PROCESSENTRY32W pe = {}; pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do {
      if (_wcsicmp(pe.szExeFile, L"msedgewebview2.exe") != 0) continue;
      if (pe.th32ProcessID == myPid) continue;
      HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pe.th32ProcessID);
      if (!hProc) continue;
      PROCESS_BASIC_INFORMATION pbi = {};
      ULONG retLen = 0;
      NTSTATUS status = NtQIP(hProc, 0, &pbi, sizeof(pbi), &retLen);
      if (status >= 0 && (DWORD_PTR)pbi.InheritedFromUniqueProcessId == myPid) {
        childPids.push_back(pe.th32ProcessID);
      }
      CloseHandle(hProc);
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);

  for (DWORD pid : childPids) {
    HANDLE hProc = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
    if (hProc) {
      TerminateProcess(hProc, 0);
      WaitForSingleObject(hProc, 5000); // 等待最多 5 秒
      CloseHandle(hProc);
    }
  }
  if (!childPids.empty()) {
    Log("KillWebView2Children: terminated " + std::to_string(childPids.size()) + " msedgewebview2.exe child processes");
  }
}

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int) {
  // ★ Per-Monitor V2 DPI 感知 — Windows 10+ 精确坐标 ★
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // ══════════ Debug 模式检测（-d 或 --debug）══════════
  {
    int nArgs = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &nArgs);
    if (argv) {
      for (int i = 1; i < nArgs; i++) {
        std::wstring arg(argv[i]);
        if (arg == L"-d" || arg == L"--debug") { g_debugMode = true; break; }
      }
      LocalFree(argv);
    }
  }

  // 初始化 GDI+
  Gdiplus::GdiplusStartupInput gpsi;
  ULONG_PTR gdipToken = 0;
  Gdiplus::GdiplusStartup(&gdipToken, &gpsi, nullptr);
  DbgLog("GDI+ initialized");

  // ══════════ 互斥体：单实例，新进程静默关闭旧进程 ══════════
  {
    const wchar_t* MUTEX_NAME = L"JadeProgAsst_Mutex_v1";
    HANDLE hMutex = CreateMutexW(nullptr, TRUE, MUTEX_NAME);
    DWORD mutexErr = GetLastError();
    bool hadPrevInstance = (hMutex && mutexErr == ERROR_ALREADY_EXISTS) || !hMutex;
    if (hadPrevInstance) {
      if (hMutex) CloseHandle(hMutex);
      // 找到并终止旧实例
      wchar_t myPath[MAX_PATH] = {};
      GetModuleFileNameW(nullptr, myPath, MAX_PATH);
      auto myName = std::filesystem::path(myPath).filename().wstring();
      DWORD myPid = GetCurrentProcessId();
      HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      int killed = 0;
      if (snap != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe = {}; pe.dwSize = sizeof(pe);
        if (Process32FirstW(snap, &pe)) {
          do {
            if (pe.th32ProcessID != myPid && _wcsicmp(pe.szExeFile, myName.c_str()) == 0) {
              HANDLE hOld = OpenProcess(PROCESS_TERMINATE, FALSE, pe.th32ProcessID);
              if (hOld) { TerminateProcess(hOld, 1); CloseHandle(hOld); killed++; }
            }
          } while (Process32NextW(snap, &pe));
        }
        CloseHandle(snap);
      }
      Sleep(600); // 等待旧进程完全退出
      hMutex = CreateMutexW(nullptr, TRUE, MUTEX_NAME); // 重新获取
      DbgLog(std::string("Single instance: killed ") + std::to_string(killed) + " old processes");
    }
    // hMutex 在整个进程生命周期保持打开，OS 在进程退出时自动释放
  }

  bool devMode = IsDeveloperMode();
  g_devMode = devMode;
  const auto exe_dir = ExeDir();
  HMODULE hMod = GetModuleHandleW(nullptr);

  // ══════════ 确定运行时目录 ══════════
  // 优先 exe 同目录（便携模式：data/、logs/ 跟随程序）。
  // 若 exe 目录不可写（只读 U 盘 / Program Files / 网络盘），回退到 LOCALAPPDATA，
  // 否则 WebView2 用户数据目录无法创建 → 界面起不来（U 盘无法运行的根因）。
  std::filesystem::path base_dir = exe_dir;
  bool usedFallback = false;
  if (!IsDirWritable(exe_dir / L"data")) {
    auto local = LocalAppDataDir();
    if (!local.empty()) { base_dir = local / L"JadeProgrammerAssistant"; usedFallback = true; }
  }
  const auto data_dir = base_dir / L"data";
  const auto log_dir = base_dir / L"logs";

  std::error_code mkec;
  std::filesystem::create_directories(data_dir, mkec);
  std::filesystem::create_directories(log_dir, mkec);
  g_log_file = log_dir / L"startup.log";
  g_test_log_file = log_dir / L"test.log";
  std::ofstream(g_log_file, std::ios::trunc | std::ios::binary) << "ProgrammerAssistant v1.3 startup\r\n";
  std::ofstream(g_test_log_file, std::ios::trunc | std::ios::binary) << "ProgrammerAssistant tests\r\n";
  if (usedFallback) Log("exe dir not writable, runtime data redirected to LOCALAPPDATA: " + WideToUtf8(base_dir.wstring()));

  // 清理 WebView2 或旧版本遗留的纯数字临时文件，避免落在 exe 同级目录。
  CleanNumericTempFiles(exe_dir, "startup-exe");
  CleanNumericTempFiles(data_dir, "startup-data");

  // WebView2 临时文件写入 data/ 而非 exe 目录
  SetCurrentDirectoryW(data_dir.c_str());

  Log(std::string("mode=") + (devMode ? "dev" : "release") + (g_debugMode ? " debug" : ""));
#ifndef RELEASE_BUILD
  DbgLog("Debug mode activated. Log output: logs/debug.log");
  DbgLog("Exe dir: " + WideToUtf8(exe_dir.wstring()));
#endif

  // ══════════ 内嵌 DLL 自动释放到 exe 同级目录 ══════════
  // DLL 必须和 exe 在一起（Windows 从 exe 目录加载 DLL）
  // 如果 exe 同目录已有 DLL 则跳过，否则从资源中释放
  {
    HRSRC hRes = FindResourceW(hMod, L"JADEVIEW_DLL", RT_RCDATA);
    if (hRes) {
      HGLOBAL hData = LoadResource(hMod, hRes);
      DWORD size = SizeofResource(hMod, hRes);
      void* ptr = LockResource(hData);
      if (ptr && size > 0) {
        auto dll_path = exe_dir / L"JadeView_x64.dll";
        bool needWrite = !std::filesystem::exists(dll_path);
        if (!needWrite) { auto es = std::filesystem::file_size(dll_path); needWrite = (es != size); }
        if (needWrite) {
          std::ofstream out(dll_path, std::ios::binary);
          out.write(reinterpret_cast<const char*>(ptr), size);
          out.close();
          Log("extracted DLL " + std::to_string(size) + " bytes to " + WideToUtf8(dll_path.wstring()));
          DbgLog(std::string("Extracted JadeView_x64.dll (") + std::to_string(size) + " bytes)");
        } else { DbgLog("DLL already present, skipped extraction"); }
      }
    }
  }

  Log("exe_dir=" + WideToUtf8(exe_dir.wstring()));
  Log("data_dir=" + WideToUtf8(data_dir.wstring()));
  Log("log_dir=" + WideToUtf8(log_dir.wstring()));

  const std::string data_utf8 = WideToUtf8(data_dir.wstring());
  const std::string log_utf8 = WideToUtf8(log_dir.wstring());

  // ★ WebView2 运行时检测（Win7/Win8 可能缺失）★
  {
    bool hasWebView2 = false;
    HKEY hk;
    if(RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", 0, KEY_READ, &hk) == ERROR_SUCCESS)
      { RegCloseKey(hk); hasWebView2 = true; }
    if(!hasWebView2 && RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", 0, KEY_READ, &hk) == ERROR_SUCCESS)
      { RegCloseKey(hk); hasWebView2 = true; }
    if(!hasWebView2){
      Log("WARNING: WebView2 runtime not detected");
      int mb = MessageBoxW(nullptr,
        L"未检测到 WebView2 (Edge) 运行时组件。\n\n"
        L"本程序依赖此组件渲染界面。\n"
        L"请下载安装 Evergreen Standalone Installer：\n\n"
        L"https://go.microsoft.com/fwlink/p/?LinkId=2124703\n\n"
        L"点击「确定」尝试继续运行（可能会失败）",
        L"Jade 编程助手 — 缺少组件", MB_ICONWARNING|MB_OK);
    }
  }

  // ★ 发布版：JadeView_load_from_bytes 内存加载 JAPK ★
  if (!devMode) {
    HRSRC hJapk = FindResourceW(hMod, L"APP_JAPK", RT_RCDATA);
    if (hJapk) {
      HGLOBAL hData = LoadResource(hMod, hJapk);
      DWORD japkSize = SizeofResource(hMod, hJapk);
      void* japkPtr = LockResource(hData);
      if (japkPtr && japkSize > 0) {
        Log(std::string("load JAPK size=") + std::to_string(japkSize));
        int32_t loadResult = JadeView_load_from_bytes(static_cast<const uint8_t*>(japkPtr), japkSize);
        Log(std::string("JadeView_load_from_bytes=") + std::to_string(loadResult));
      }
    }
  }
  Log("JadeView_init");
  DbgLog("Initializing JadeView framework...");
  int32_t init_result = JadeView_init(1, log_utf8.c_str(), data_utf8.c_str(), "ProgrammerAssistant", "programmer-assistant", 0);
  Log("JadeView_init devMode=" + std::to_string((int)devMode));
  Log("JadeView_init=" + std::to_string(init_result));
  if (init_result == 0) {
    DbgLog("JadeView_init FAILED", true);
    MessageBoxW(nullptr, L"JadeView init failed", L"Programmer Assistant", MB_ICONERROR); return 1;
  }
  DbgLog("JadeView framework initialized");

  // ══════════ 事件监听（必须在 init 之后、app-ready 之前注册）══════════
  jade_on(JADEVIEW_EVENT_WINDOW_CREATED, LogEvent);
  jade_on(JADEVIEW_EVENT_WEBVIEW_DID_START_LOADING, LogEvent);
  jade_on(JADEVIEW_EVENT_WEBVIEW_DID_FINISH_LOAD, OnWebViewLoad);
  jade_on(JADEVIEW_EVENT_WEBVIEW_PAGE_TITLE_UPDATED, LogEvent);
  jade_on(JADEVIEW_EVENT_CRASH, LogEvent);
  jade_on(JADEVIEW_EVENT_WINDOW_CLOSED, OnWindowClosed);
  jade_on(JADEVIEW_EVENT_WINDOW_ALL_CLOSED, OnWindowClosed);
  jade_on(JADEVIEW_EVENT_DRAG_DROP, OnDragDrop);
  jade_on(JADEVIEW_EVENT_APP_READY, CreateMainWindow);
  DbgLog("Event listeners registered after JAPK load");

  Log("register ipc");
  register_ipc_handler("convert_encoding", ConvertEncoding);
  register_ipc_handler("apply_theme", ApplyTheme);
  register_ipc_handler("window_control", WindowControl);
  register_ipc_handler("inspect_msaa", InspectMsaa);
  register_ipc_handler("pick_msaa_window", PickMsaaWindow);
  register_ipc_handler("get_fonts", GetFontList);
  register_ipc_handler("set_startup", SetStartup);
  register_ipc_handler("native_http", NativeHttpRequest);
  register_ipc_handler("list_processes", ListProcesses);
  register_ipc_handler("kill_process", KillProcess);
  register_ipc_handler("open_process_path", OpenProcessPath);
  register_ipc_handler("spy_windows", SpyWindows);
  register_ipc_handler("spy_detail", SpyDetail);
  register_ipc_handler("spy_tree", SpyTree);
  register_ipc_handler("spy_child_tree", SpyChildTree);
  register_ipc_handler("get_window_icon", GetWindowIcon);
  register_ipc_handler("proxy_validate", ProxyValidate);
  register_ipc_handler("pick_screen_color", PickScreenColor);
  register_ipc_handler("hash_text", HashText);
  register_ipc_handler("save_text", SaveTextFile);
  register_ipc_handler("extract_icon", ExtractProcIcon);
  register_ipc_handler("save_proc_icon", SaveProcIcon);
  register_ipc_handler("toggle_devtools", ToggleDevtools);
  register_ipc_handler("test_log", TestLog);
  register_ipc_handler("ws_open", WsOpen);
  register_ipc_handler("ws_send", WsSend);
  register_ipc_handler("ws_poll", WsPoll);
  register_ipc_handler("ws_close", WsClose);
  // YOLO 工具
  register_ipc_handler("yolo_pick_file", yolo::PickFile);
  register_ipc_handler("yolo_pick_dir", yolo::PickDir);
  register_ipc_handler("yolo_list_images", yolo::ListImages);
  register_ipc_handler("yolo_read_image", yolo::ReadImage);
  register_ipc_handler("yolo_read_text", yolo::ReadText);
  register_ipc_handler("yolo_write_text", yolo::WriteText);
  register_ipc_handler("yolo_env_detect", yolo::EnvDetect);
  register_ipc_handler("yolo_train_start", yolo::TrainStart);
  register_ipc_handler("yolo_train_poll", yolo::TrainPoll);
  register_ipc_handler("yolo_train_stop", yolo::TrainStop);
  register_ipc_handler("yolo_infer", yolo::Infer);
  register_ipc_handler("yolo_open_annotator", yolo::OpenAnnotator);
  register_ipc_handler("yolo_detect_python", yolo::PyDetect);
  register_ipc_handler("yolo_py_check", yolo::PyCheck);
  register_ipc_handler("yolo_py_install", yolo::PyInstall);

  char app_url[2048] = {};
  if (devMode) {
    const auto web_dir = exe_dir / L"web";
    const std::string web_utf8 = WideToUtf8(web_dir.wstring());
    DbgLog("Dev mode: registering protocol path=" + web_utf8);
    int32_t protocol_result = set_protocol_service_path(web_utf8.c_str(), app_url, sizeof(app_url), 1);
    Log("set_protocol_service_path=" + std::to_string(protocol_result));
    if (!protocol_result || app_url[0] == '\0') {
      DbgLog("set_protocol_service_path(dev) FAILED", true);
      MessageBoxW(nullptr, L"Register web failed", L"Error", MB_ICONERROR); return 2;
    }
    DbgLog(std::string("Dev protocol URL: ") + app_url);
  } else {
    int32_t protocol_result = set_protocol_service_path("", app_url, sizeof(app_url), 0);
    Log("set_protocol_service_path(release)=" + std::to_string(protocol_result));
    if (!protocol_result || app_url[0] == '\0') {
      MessageBoxW(nullptr, L"JAPK load failed", L"Error", MB_ICONERROR);
      return 2;
    }
  }
  Log(std::string("url=") + app_url);

  g_index_url = app_url;
  DbgLog("Entering message loop. " + std::to_string(20) + " IPC handlers registered.");
  Log("entering message loop");
  int32_t loop_result = run_message_loop();
  Log("run_message_loop result=" + std::to_string(loop_result));
  DbgLog(std::string("Message loop exited (code ") + std::to_string(loop_result) + ")");

  // ★ 完整清理顺序：窗口→JAPK→GDI+→子进程→文件 ★
  Log("exit: jadeview_exit");
  jadeview_exit();
  Log("exit: JadeView_unload");
  JadeView_unload();

  // 清理 GDI+
  Gdiplus::GdiplusShutdown(gdipToken);

  // 终止 WebView2 子进程并等待退出
  KillWebView2Children();
  Sleep(800);  // 给系统一点时间释放文件句柄

  // 清理临时文件（exe 目录 + data 目录均需清理）
  CleanNumericTempFiles(exe_dir, "exit-exe");
  CleanNumericTempFiles(data_dir, "exit-data");

  Log("exit: done");
  return loop_result;
}
