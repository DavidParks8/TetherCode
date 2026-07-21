use crate::*;

#[derive(Debug)]
pub(super) struct PreviewBootstrapParams {
    pub(super) session_id: Option<String>,
    pub(super) bootstrap_token: Option<String>,
    pub(super) viewport: Option<PreviewViewportConfig>,
    pub(super) shell_mode: Option<PreviewShellMode>,
    pub(super) raw_frame: bool,
    pub(super) sanitized_path_and_query: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PreviewShellMode {
    Desktop,
    Overview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PreviewViewportPreset {
    Mobile,
    Desktop,
}

pub(super) const DEFAULT_PREVIEW_DESKTOP_WIDTH: u32 = 1920;
pub(super) const DEFAULT_PREVIEW_DESKTOP_HEIGHT: u32 = 1080;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PreviewViewportConfig {
    pub(super) preset: PreviewViewportPreset,
    pub(super) width: Option<u32>,
    pub(super) height: Option<u32>,
}

impl PreviewViewportConfig {
    pub(super) fn as_cookie_value(self) -> String {
        match self.preset {
            PreviewViewportPreset::Mobile => "mobile".to_string(),
            PreviewViewportPreset::Desktop => match (self.width, self.height) {
                (Some(width), Some(height)) => format!("desktop:{width}:{height}"),
                (Some(width), None) => format!("desktop:{width}"),
                _ => "desktop".to_string(),
            },
        }
    }

    pub(super) fn viewport_meta_content(self) -> Option<String> {
        match self.preset {
            PreviewViewportPreset::Mobile => None,
            PreviewViewportPreset::Desktop => {
                let width = self.width.unwrap_or(DEFAULT_PREVIEW_DESKTOP_WIDTH);
                let height = self.height.or_else(|| {
                    if self.width.is_none() {
                        Some(DEFAULT_PREVIEW_DESKTOP_HEIGHT)
                    } else {
                        None
                    }
                });
                let mut parts = vec![format!("width={width}")];
                if let Some(height) = height {
                    parts.push(format!("height={height}"));
                }
                parts.push("initial-scale=1".to_string());
                parts.push("minimum-scale=0.1".to_string());
                parts.push("maximum-scale=5".to_string());
                parts.push("user-scalable=yes".to_string());
                Some(parts.join(", "))
            }
        }
    }
}

pub(super) fn parse_preview_viewport_preset(raw: &str) -> Option<PreviewViewportPreset> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "mobile" => Some(PreviewViewportPreset::Mobile),
        "desktop" => Some(PreviewViewportPreset::Desktop),
        _ => None,
    }
}

pub(super) fn parse_preview_shell_mode(raw: &str) -> Option<PreviewShellMode> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "desktop" => Some(PreviewShellMode::Desktop),
        "overview" => Some(PreviewShellMode::Overview),
        _ => None,
    }
}

pub(super) fn normalize_preview_viewport_dimension(raw: Option<&str>) -> Option<u32> {
    let value = raw?.trim().parse::<u32>().ok()?;
    if !(320..=4096).contains(&value) {
        return None;
    }
    Some(value)
}

pub(super) fn build_preview_viewport_config(
    preset: Option<PreviewViewportPreset>,
    width: Option<u32>,
    height: Option<u32>,
) -> Option<PreviewViewportConfig> {
    match preset? {
        PreviewViewportPreset::Mobile => Some(PreviewViewportConfig {
            preset: PreviewViewportPreset::Mobile,
            width: None,
            height: None,
        }),
        PreviewViewportPreset::Desktop => Some(PreviewViewportConfig {
            preset: PreviewViewportPreset::Desktop,
            width,
            height,
        }),
    }
}

#[derive(Debug)]
pub(super) struct ResolvedPreviewRequest {
    pub(super) session: BrowserPreviewResolvedSession,
    pub(super) bootstrap_session_id: Option<String>,
    pub(super) bootstrap_token: Option<String>,
    pub(super) requested_viewport: Option<PreviewViewportConfig>,
    pub(super) requested_shell_mode: Option<PreviewShellMode>,
    pub(super) raw_frame: bool,
    pub(super) sanitized_path_and_query: String,
}

pub(super) async fn resolve_preview_session_from_request(
    preview: &BrowserPreviewService,
    headers: &HeaderMap,
    uri: &Uri,
) -> Result<ResolvedPreviewRequest, Response> {
    let params = parse_preview_bootstrap_params(uri);
    if let (Some(session_id), Some(bootstrap_token)) = (
        params.session_id.as_deref(),
        params.bootstrap_token.as_deref(),
    ) {
        let Some(session) = preview.resolve_bootstrap(session_id, bootstrap_token).await else {
            return Err(preview_error_response(
                StatusCode::UNAUTHORIZED,
                "preview session is invalid or expired; reopen it from Clawdex",
            ));
        };

        return Ok(ResolvedPreviewRequest {
            bootstrap_session_id: Some(session.session_id.clone()),
            session,
            bootstrap_token: Some(bootstrap_token.to_string()),
            requested_viewport: params.viewport,
            requested_shell_mode: params.shell_mode,
            raw_frame: params.raw_frame,
            sanitized_path_and_query: params.sanitized_path_and_query,
        });
    }

    let Some(cookie_token) = read_cookie_value(headers, BROWSER_PREVIEW_COOKIE_NAME) else {
        return Err(preview_error_response(
            StatusCode::UNAUTHORIZED,
            "preview session is missing; reopen it from Clawdex",
        ));
    };
    let Some(session) = preview.resolve_cookie(&cookie_token).await else {
        return Err(preview_error_response(
            StatusCode::UNAUTHORIZED,
            "preview session expired; reopen it from Clawdex",
        ));
    };

    Ok(ResolvedPreviewRequest {
        bootstrap_session_id: Some(session.session_id.clone()),
        session,
        bootstrap_token: None,
        requested_viewport: params.viewport,
        requested_shell_mode: params.shell_mode,
        raw_frame: params.raw_frame,
        sanitized_path_and_query: params.sanitized_path_and_query,
    })
}

pub(super) fn parse_preview_bootstrap_params(uri: &Uri) -> PreviewBootstrapParams {
    let Ok(mut parsed) = Url::parse(&format!("http://preview{}", uri)) else {
        return PreviewBootstrapParams {
            session_id: None,
            bootstrap_token: None,
            viewport: None,
            shell_mode: None,
            raw_frame: false,
            sanitized_path_and_query: uri
                .path_and_query()
                .map(|value| value.as_str().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "/".to_string()),
        };
    };

    let mut session_id = None;
    let mut bootstrap_token = None;
    let mut viewport_preset = None;
    let mut viewport_width = None;
    let mut viewport_height = None;
    let mut shell_mode = None;
    let mut raw_frame = false;
    let mut retained_pairs = Vec::new();
    for (key, value) in parsed.query_pairs() {
        if key == "sid" {
            session_id = Some(value.to_string());
            continue;
        }
        if key == "st" {
            bootstrap_token = Some(value.to_string());
            continue;
        }
        if key == "vp" {
            viewport_preset = parse_preview_viewport_preset(&value);
            retained_pairs.push((key.to_string(), value.to_string()));
            continue;
        }
        if key == "vw" {
            viewport_width = normalize_preview_viewport_dimension(Some(value.as_ref()));
            retained_pairs.push((key.to_string(), value.to_string()));
            continue;
        }
        if key == "vh" {
            viewport_height = normalize_preview_viewport_dimension(Some(value.as_ref()));
            retained_pairs.push((key.to_string(), value.to_string()));
            continue;
        }
        if key == "shell" {
            shell_mode = parse_preview_shell_mode(&value);
            retained_pairs.push((key.to_string(), value.to_string()));
            continue;
        }
        if key == "frame" {
            raw_frame = value == "1";
            continue;
        }
        retained_pairs.push((key.to_string(), value.to_string()));
    }

    parsed.set_query(None);
    if !retained_pairs.is_empty() {
        let mut query_pairs = parsed.query_pairs_mut();
        for (key, value) in &retained_pairs {
            query_pairs.append_pair(key, value);
        }
    }

    let sanitized_path_and_query = format!(
        "{}{}",
        parsed.path(),
        parsed
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default()
    );

    PreviewBootstrapParams {
        session_id,
        bootstrap_token,
        viewport: build_preview_viewport_config(viewport_preset, viewport_width, viewport_height),
        shell_mode,
        raw_frame,
        sanitized_path_and_query,
    }
}

pub(super) fn preview_bootstrap_redirect_response(
    sanitized_path_and_query: &str,
    bootstrap_token: &str,
    viewport: Option<PreviewViewportConfig>,
    secure_cookie: bool,
) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::TEMPORARY_REDIRECT;
    response.headers_mut().insert(
        LOCATION,
        HeaderValue::from_str(sanitized_path_and_query)
            .unwrap_or_else(|_| HeaderValue::from_static("/")),
    );
    if let Ok(cookie) = build_preview_cookie_header(bootstrap_token, secure_cookie) {
        response.headers_mut().append(SET_COOKIE, cookie);
    }
    if let Some(viewport) = viewport {
        if let Ok(cookie) = build_preview_viewport_cookie_header(viewport) {
            response.headers_mut().append(SET_COOKIE, cookie);
        }
    }
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store, private"));
    apply_preview_security_headers(&mut response);
    response
}

pub(super) fn append_preview_bootstrap_headers(
    response: &mut Response,
    bootstrap_token: Option<&str>,
    viewport: Option<PreviewViewportConfig>,
    secure_cookie: bool,
) {
    if let Some(token) = bootstrap_token {
        if let Ok(cookie) = build_preview_cookie_header(token, secure_cookie) {
            response.headers_mut().append(SET_COOKIE, cookie);
        }
    }

    if let Some(viewport) = viewport {
        if let Ok(cookie) = build_preview_viewport_cookie_header(viewport) {
            response.headers_mut().append(SET_COOKIE, cookie);
        }
    }
}

pub(super) fn build_preview_shell_frame_src(
    sanitized_path_and_query: &str,
    _bootstrap_session_id: Option<&str>,
    _bootstrap_token: Option<&str>,
) -> String {
    let Ok(mut parsed) = Url::parse(&format!("http://preview{sanitized_path_and_query}")) else {
        return if sanitized_path_and_query.contains('?') {
            format!("{sanitized_path_and_query}&frame=1")
        } else {
            format!("{sanitized_path_and_query}?frame=1")
        };
    };

    let mut kept_pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter_map(|(key, value)| {
            let should_drop =
                matches!(key.as_ref(), "shell" | "frame") || key == "sid" || key == "st";
            if should_drop {
                None
            } else {
                Some((key.into_owned(), value.into_owned()))
            }
        })
        .collect();

    {
        let mut query_pairs = parsed.query_pairs_mut();
        query_pairs.clear();
        for (key, value) in kept_pairs.drain(..) {
            query_pairs.append_pair(&key, &value);
        }
        query_pairs.append_pair("frame", "1");
    }

    format!(
        "{}{}",
        parsed.path(),
        parsed
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default()
    )
}

pub(super) fn build_preview_shell_request_key(
    bootstrap_session_id: Option<&str>,
    _bootstrap_token: Option<&str>,
) -> Option<String> {
    Some(bootstrap_session_id?.to_string())
}

pub(super) fn preview_error_response(status: StatusCode, message: &str) -> Response {
    let body = format!(
        "<!doctype html><html><body style=\"font-family:-apple-system,system-ui,sans-serif;padding:24px;background:#111;color:#f5f5f5\"><h1 style=\"font-size:18px;margin:0 0 12px\">Preview unavailable</h1><p style=\"margin:0;color:#d4d4d4\">{}</p></body></html>",
        html_escape(message)
    );
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .header(REFERRER_POLICY, "no-referrer")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from(message.to_string())))
}

pub(super) fn build_preview_cookie_header(
    bootstrap_token: &str,
    secure_cookie: bool,
) -> Result<HeaderValue, String> {
    let secure = if secure_cookie { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{BROWSER_PREVIEW_COOKIE_NAME}={bootstrap_token}; HttpOnly; Path=/; SameSite=Strict; Max-Age={}{}",
        BROWSER_PREVIEW_SESSION_TTL.as_secs(),
        secure,
    ))
    .map_err(|error| error.to_string())
}

pub(super) fn build_preview_viewport_cookie_header(
    viewport: PreviewViewportConfig,
) -> Result<HeaderValue, String> {
    HeaderValue::from_str(&format!(
        "{BROWSER_PREVIEW_VIEWPORT_COOKIE_NAME}={}; Path=/; SameSite=Lax; Max-Age={}",
        viewport.as_cookie_value(),
        BROWSER_PREVIEW_SESSION_TTL.as_secs()
    ))
    .map_err(|error| error.to_string())
}

pub(super) fn read_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw_cookie = headers.get(COOKIE)?.to_str().ok()?;
    for segment in raw_cookie.split(';') {
        let trimmed = segment.trim();
        let Some((cookie_name, cookie_value)) = trimmed.split_once('=') else {
            continue;
        };
        if cookie_name.trim() == name {
            let value = cookie_value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub(super) fn parse_preview_viewport_cookie(raw: &str) -> Option<PreviewViewportConfig> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut parts = trimmed.split(':');
    let preset = parse_preview_viewport_preset(parts.next()?)?;
    let raw_width = parts.next();
    let raw_height = parts.next();
    if parts.next().is_some() {
        return None;
    }
    let width = normalize_preview_viewport_dimension(raw_width);
    let height = normalize_preview_viewport_dimension(raw_height);
    if raw_width.is_some_and(|value| !value.trim().is_empty()) && width.is_none()
        || raw_height.is_some_and(|value| !value.trim().is_empty()) && height.is_none()
    {
        return None;
    }
    build_preview_viewport_config(Some(preset), width, height)
}

pub(super) fn read_preview_viewport_preset(headers: &HeaderMap) -> Option<PreviewViewportConfig> {
    read_cookie_value(headers, BROWSER_PREVIEW_VIEWPORT_COOKIE_NAME)
        .as_deref()
        .and_then(parse_preview_viewport_cookie)
}

pub(super) fn preview_desktop_shell_response(
    sanitized_path_and_query: &str,
    viewport: PreviewViewportConfig,
    bootstrap_session_id: Option<&str>,
    bootstrap_token: Option<&str>,
) -> Response {
    let desktop_width = viewport.width.unwrap_or(DEFAULT_PREVIEW_DESKTOP_WIDTH);
    let desktop_height = viewport.height.unwrap_or(DEFAULT_PREVIEW_DESKTOP_HEIGHT);
    let frame_src = build_preview_shell_frame_src(
        sanitized_path_and_query,
        bootstrap_session_id,
        bootstrap_token,
    );
    let frame_src_json = serde_json::to_string(&frame_src).unwrap_or_else(|_| "\"/\"".to_string());
    let shell_request_key_json = serde_json::to_string(&build_preview_shell_request_key(
        bootstrap_session_id,
        bootstrap_token,
    ))
    .unwrap_or_else(|_| "null".to_string());
    let body = format!(
        r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta id="viewport-meta" name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.1, maximum-scale=5, user-scalable=yes">
    <style>
      html, body {{
        margin: 0;
        padding: 0;
        min-height: 100%;
        background: #fff;
      }}
      body {{
        overflow-x: auto;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }}
      #shell {{
        width: {desktop_width}px;
        min-height: {desktop_height}px;
      }}
      #frame {{
        display: block;
        width: {desktop_width}px;
        min-height: {desktop_height}px;
        border: 0;
        background: #fff;
      }}
    </style>
  </head>
  <body>
    <div id="shell">
      <iframe id="frame" title="Desktop preview"></iframe>
    </div>
    <script>
      (function() {{
        var frame = document.getElementById('frame');
        var shell = document.getElementById('shell');
        var viewportMeta = document.getElementById('viewport-meta');
        var desktopWidth = {desktop_width};
        var minimumDesktopHeight = {desktop_height};
        var frameSrc = {frame_src_json};
        var lastMeasuredHeight = 0;
        var lastPostedStateJson = '';
        var knownHistory = [];
        var knownHistoryIndex = -1;
        var frameResizeObserver = null;
        var frameMutationObserver = null;
        var frameCleanupCallbacks = [];
        var measureFrameQueued = false;
        var initialFitApplied = false;

        function currentFrameWindow() {{
          try {{
            return frame.contentWindow || null;
          }} catch (_error) {{
            return null;
          }}
        }}

        function currentFrameDocument() {{
          try {{
            return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
          }} catch (_error) {{
            return null;
          }}
        }}

        function cleanupFrameObservers() {{
          if (frameResizeObserver) {{
            frameResizeObserver.disconnect();
            frameResizeObserver = null;
          }}
          if (frameMutationObserver) {{
            frameMutationObserver.disconnect();
            frameMutationObserver = null;
          }}
          while (frameCleanupCallbacks.length > 0) {{
            var callback = frameCleanupCallbacks.pop();
            try {{
              callback();
            }} catch (_error) {{}}
          }}
        }}

        function syncHistory(rawUrl) {{
          if (!rawUrl) {{
            return;
          }}
          if (knownHistoryIndex >= 0 && knownHistory[knownHistoryIndex] === rawUrl) {{
            return;
          }}
          if (knownHistoryIndex > 0 && knownHistory[knownHistoryIndex - 1] === rawUrl) {{
            knownHistoryIndex -= 1;
            return;
          }}
          if (
            knownHistoryIndex + 1 < knownHistory.length &&
            knownHistory[knownHistoryIndex + 1] === rawUrl
          ) {{
            knownHistoryIndex += 1;
            return;
          }}
          knownHistory = knownHistory.slice(0, knownHistoryIndex + 1);
          knownHistory.push(rawUrl);
          knownHistoryIndex = knownHistory.length - 1;
        }}

        function postState() {{
          if (
            !window.ReactNativeWebView ||
            typeof window.ReactNativeWebView.postMessage !== 'function'
          ) {{
            return;
          }}

          var rawUrl = '';
          var title = '';
          try {{
            var win = currentFrameWindow();
            rawUrl = win && win.location ? String(win.location.href) : '';
          }} catch (_error) {{}}
          try {{
            var doc = currentFrameDocument();
            title = doc ? String(doc.title || '') : '';
          }} catch (_error) {{}}
          syncHistory(rawUrl);
          var nextStateJson = JSON.stringify({{
            type: 'clawdexDesktopFrameState',
            shellRequestKey: {shell_request_key_json},
            rawUrl: rawUrl,
            title: title,
            canGoBack: knownHistoryIndex > 0,
            canGoForward: knownHistoryIndex >= 0 && knownHistoryIndex < knownHistory.length - 1,
          }});
          if (nextStateJson === lastPostedStateJson) {{
            return;
          }}
          lastPostedStateJson = nextStateJson;
          window.ReactNativeWebView.postMessage(nextStateJson);
        }}

        function applyInitialFit() {{
          if (initialFitApplied || !viewportMeta) {{
            return;
          }}
          var viewportWidth = Math.max(
            window.innerWidth || document.documentElement.clientWidth || 0,
            1
          );
          var scale = Math.min(1, viewportWidth / desktopWidth);
          viewportMeta.setAttribute(
            'content',
            'width=' +
              desktopWidth +
              ', initial-scale=' +
              scale +
              ', minimum-scale=' +
              Math.min(scale, 1) +
              ', maximum-scale=5, user-scalable=yes'
          );
          initialFitApplied = true;
        }}

        function measureFrameHeight() {{
          measureFrameQueued = false;
          if (minimumDesktopHeight !== lastMeasuredHeight) {{
            lastMeasuredHeight = minimumDesktopHeight;
            frame.style.height = minimumDesktopHeight + 'px';
            shell.style.height = minimumDesktopHeight + 'px';
          }}
          applyInitialFit();
          postState();
        }}

        function queueMeasureFrameHeight() {{
          if (measureFrameQueued) {{
            return;
          }}
          measureFrameQueued = true;
          window.requestAnimationFrame(function() {{
            measureFrameHeight();
          }});
        }}

        function installFrameObservers() {{
          cleanupFrameObservers();
          var win = currentFrameWindow();
          var doc = currentFrameDocument();
          if (!win || !doc) {{
            return;
          }}

          function addFrameListener(target, eventName, handler, options) {{
            if (!target || typeof target.addEventListener !== 'function') {{
              return;
            }}
            target.addEventListener(eventName, handler, options);
            frameCleanupCallbacks.push(function() {{
              try {{
                target.removeEventListener(eventName, handler, options);
              }} catch (_error) {{}}
            }});
          }}

          if (typeof ResizeObserver === 'function') {{
            frameResizeObserver = new ResizeObserver(function() {{
              queueMeasureFrameHeight();
            }});
            if (doc.documentElement) {{
              frameResizeObserver.observe(doc.documentElement);
            }}
            if (doc.body) {{
              frameResizeObserver.observe(doc.body);
            }}
          }}

          if (typeof MutationObserver === 'function' && doc.head) {{
            frameMutationObserver = new MutationObserver(function() {{
              postState();
            }});
            frameMutationObserver.observe(doc.head, {{
              childList: true,
              subtree: true,
              characterData: true,
            }});
          }}

          addFrameListener(win, 'load', queueMeasureFrameHeight, {{ passive: true }});
          addFrameListener(win, 'pageshow', queueMeasureFrameHeight, {{ passive: true }});
          addFrameListener(win, 'hashchange', postState, {{ passive: true }});
          addFrameListener(win, 'popstate', postState, {{ passive: true }});

          if (doc.fonts && typeof doc.fonts.ready === 'object' && typeof doc.fonts.ready.then === 'function') {{
            doc.fonts.ready.then(queueMeasureFrameHeight).catch(function() {{}});
          }}

          if (!win.__clawdexDesktopFramePatched && win.history) {{
            win.__clawdexDesktopFramePatched = true;
            var originalPushState = typeof win.history.pushState === 'function' ? win.history.pushState.bind(win.history) : null;
            var originalReplaceState = typeof win.history.replaceState === 'function' ? win.history.replaceState.bind(win.history) : null;
            if (originalPushState) {{
              win.history.pushState = function() {{
                var result = originalPushState.apply(null, arguments);
                postState();
                queueMeasureFrameHeight();
                return result;
              }};
            }}
            if (originalReplaceState) {{
              win.history.replaceState = function() {{
                var result = originalReplaceState.apply(null, arguments);
                postState();
                queueMeasureFrameHeight();
                return result;
              }};
            }}
          }}
        }}

        frame.addEventListener('load', function() {{
          installFrameObservers();
          queueMeasureFrameHeight();
          setTimeout(queueMeasureFrameHeight, 120);
          setTimeout(queueMeasureFrameHeight, 400);
        }});
        window.addEventListener('resize', queueMeasureFrameHeight, {{ passive: true }});

        window.__clawdexDesktopFrame = {{
          goBack: function() {{
            var win = currentFrameWindow();
            if (win) {{
              win.history.back();
            }}
          }},
          goForward: function() {{
            var win = currentFrameWindow();
            if (win) {{
              win.history.forward();
            }}
          }},
          reload: function() {{
            lastPostedStateJson = '';
            var win = currentFrameWindow();
            if (win) {{
              win.location.reload();
            }} else {{
              frame.src = frame.src;
            }}
          }},
        }};

        shell.style.height = minimumDesktopHeight + 'px';
        frame.style.height = minimumDesktopHeight + 'px';
        applyInitialFit();
        frame.src = frameSrc;
      }})();
    </script>
  </body>
</html>"#
    );

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .header(CACHE_CONTROL, "no-store, private")
        .header(REFERRER_POLICY, "no-referrer")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from(String::new())))
}

pub(super) fn preview_overview_shell_response(
    sanitized_path_and_query: &str,
    viewport: PreviewViewportConfig,
    bootstrap_session_id: Option<&str>,
    bootstrap_token: Option<&str>,
) -> Response {
    let desktop_width = viewport.width.unwrap_or(DEFAULT_PREVIEW_DESKTOP_WIDTH);
    let desktop_height = viewport.height.unwrap_or(DEFAULT_PREVIEW_DESKTOP_HEIGHT);
    let frame_src = build_preview_shell_frame_src(
        sanitized_path_and_query,
        bootstrap_session_id,
        bootstrap_token,
    );
    let frame_src_json = serde_json::to_string(&frame_src).unwrap_or_else(|_| "\"/\"".to_string());
    let shell_request_key_json = serde_json::to_string(&build_preview_shell_request_key(
        bootstrap_session_id,
        bootstrap_token,
    ))
    .unwrap_or_else(|_| "null".to_string());
    let body = format!(
        r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta id="viewport-meta" name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.1, maximum-scale=5, user-scalable=yes">
    <style>
      html, body {{
        margin: 0;
        padding: 0;
        min-height: 100%;
        background: #000;
      }}
      body {{
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }}
      #shell {{
        width: {desktop_width}px;
        min-height: {desktop_height}px;
        overflow: visible;
      }}
      #frame {{
        display: block;
        width: {desktop_width}px;
        min-height: {desktop_height}px;
        border: 0;
        background: #fff;
      }}
    </style>
  </head>
  <body>
    <div id="shell">
      <iframe id="frame" title="Overview preview"></iframe>
    </div>
    <script>
      (function() {{
        var frame = document.getElementById('frame');
        var shell = document.getElementById('shell');
        var viewportMeta = document.getElementById('viewport-meta');
        var desktopWidth = {desktop_width};
        var minimumDesktopHeight = {desktop_height};
        var frameSrc = {frame_src_json};
        var lastMeasuredHeight = minimumDesktopHeight;
        var lastPostedStateJson = '';
        var knownHistory = [];
        var knownHistoryIndex = -1;
        var frameResizeObserver = null;
        var frameMutationObserver = null;
        var frameCleanupCallbacks = [];
        var measureFrameQueued = false;
        var initialFitApplied = false;

        function currentFrameWindow() {{
          try {{
            return frame.contentWindow || null;
          }} catch (_error) {{
            return null;
          }}
        }}

        function currentFrameDocument() {{
          try {{
            return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || null;
          }} catch (_error) {{
            return null;
          }}
        }}

        function cleanupFrameObservers() {{
          if (frameResizeObserver) {{
            frameResizeObserver.disconnect();
            frameResizeObserver = null;
          }}
          if (frameMutationObserver) {{
            frameMutationObserver.disconnect();
            frameMutationObserver = null;
          }}
          while (frameCleanupCallbacks.length > 0) {{
            var callback = frameCleanupCallbacks.pop();
            try {{
              callback();
            }} catch (_error) {{}}
          }}
        }}

        function syncHistory(rawUrl) {{
          if (!rawUrl) {{
            return;
          }}
          if (knownHistoryIndex >= 0 && knownHistory[knownHistoryIndex] === rawUrl) {{
            return;
          }}
          if (knownHistoryIndex > 0 && knownHistory[knownHistoryIndex - 1] === rawUrl) {{
            knownHistoryIndex -= 1;
            return;
          }}
          if (
            knownHistoryIndex + 1 < knownHistory.length &&
            knownHistory[knownHistoryIndex + 1] === rawUrl
          ) {{
            knownHistoryIndex += 1;
            return;
          }}
          knownHistory = knownHistory.slice(0, knownHistoryIndex + 1);
          knownHistory.push(rawUrl);
          knownHistoryIndex = knownHistory.length - 1;
        }}

        function postState() {{
          if (
            !window.ReactNativeWebView ||
            typeof window.ReactNativeWebView.postMessage !== 'function'
          ) {{
            return;
          }}

          var rawUrl = '';
          var title = '';
          try {{
            var win = currentFrameWindow();
            rawUrl = win && win.location ? String(win.location.href) : '';
          }} catch (_error) {{}}
          try {{
            var doc = currentFrameDocument();
            title = doc ? String(doc.title || '') : '';
          }} catch (_error) {{}}
          syncHistory(rawUrl);
          var nextStateJson = JSON.stringify({{
            type: 'clawdexDesktopFrameState',
            shellRequestKey: {shell_request_key_json},
            rawUrl: rawUrl,
            title: title,
            canGoBack: knownHistoryIndex > 0,
            canGoForward: knownHistoryIndex >= 0 && knownHistoryIndex < knownHistory.length - 1,
          }});
          if (nextStateJson === lastPostedStateJson) {{
            return;
          }}
          lastPostedStateJson = nextStateJson;
          window.ReactNativeWebView.postMessage(nextStateJson);
        }}

        function applyInitialFit(contentHeight) {{
          if (initialFitApplied || !viewportMeta) {{
            return;
          }}
          var viewportWidth = Math.max(
            (window.visualViewport && window.visualViewport.width) || window.innerWidth || 0,
            1
          );
          var viewportHeight = Math.max(
            (window.visualViewport && window.visualViewport.height) || window.innerHeight || 0,
            1
          );
          var scale = Math.min(1, viewportWidth / desktopWidth, viewportHeight / contentHeight);
          viewportMeta.setAttribute(
            'content',
            'width=' +
              desktopWidth +
              ', initial-scale=' +
              scale +
              ', minimum-scale=' +
              scale +
              ', maximum-scale=5, user-scalable=yes'
          );
          initialFitApplied = true;
        }}

        function applyLayout(contentHeight) {{
          shell.style.width = desktopWidth + 'px';
          shell.style.height = contentHeight + 'px';
          frame.style.width = desktopWidth + 'px';
          frame.style.height = contentHeight + 'px';
        }}

        function measureFrameHeight() {{
          measureFrameQueued = false;
          var doc = currentFrameDocument();
          var height = minimumDesktopHeight;
          if (doc && doc.documentElement) {{
            var html = doc.documentElement;
            var body = doc.body;
            html.style.overflow = 'hidden';
            if (body) {{
              body.style.overflow = 'hidden';
            }}
            height = Math.max(
              minimumDesktopHeight,
              html.scrollHeight || 0,
              html.offsetHeight || 0,
              body ? body.scrollHeight || 0 : 0,
              body ? body.offsetHeight || 0 : 0
            );
          }}

          if (height !== lastMeasuredHeight) {{
            lastMeasuredHeight = height;
          }}
          applyLayout(height);
          applyInitialFit(height);
          postState();
        }}

        function queueMeasureFrameHeight() {{
          if (measureFrameQueued) {{
            return;
          }}
          measureFrameQueued = true;
          window.requestAnimationFrame(function() {{
            measureFrameHeight();
          }});
        }}

        function installFrameObservers() {{
          cleanupFrameObservers();
          var win = currentFrameWindow();
          var doc = currentFrameDocument();
          if (!win || !doc) {{
            return;
          }}

          function addFrameListener(target, eventName, handler, options) {{
            if (!target || typeof target.addEventListener !== 'function') {{
              return;
            }}
            target.addEventListener(eventName, handler, options);
            frameCleanupCallbacks.push(function() {{
              try {{
                target.removeEventListener(eventName, handler, options);
              }} catch (_error) {{}}
            }});
          }}

          if (typeof ResizeObserver === 'function') {{
            frameResizeObserver = new ResizeObserver(function() {{
              queueMeasureFrameHeight();
            }});
            if (doc.documentElement) {{
              frameResizeObserver.observe(doc.documentElement);
            }}
            if (doc.body) {{
              frameResizeObserver.observe(doc.body);
            }}
          }}

          if (typeof MutationObserver === 'function' && doc.head) {{
            frameMutationObserver = new MutationObserver(function() {{
              postState();
            }});
            frameMutationObserver.observe(doc.head, {{
              childList: true,
              subtree: true,
              characterData: true,
            }});
          }}

          addFrameListener(win, 'load', queueMeasureFrameHeight, {{ passive: true }});
          addFrameListener(win, 'pageshow', queueMeasureFrameHeight, {{ passive: true }});
          addFrameListener(win, 'hashchange', postState, {{ passive: true }});
          addFrameListener(win, 'popstate', postState, {{ passive: true }});

          if (doc.fonts && typeof doc.fonts.ready === 'object' && typeof doc.fonts.ready.then === 'function') {{
            doc.fonts.ready.then(queueMeasureFrameHeight).catch(function() {{}});
          }}

          if (!win.__clawdexDesktopFramePatched && win.history) {{
            win.__clawdexDesktopFramePatched = true;
            var originalPushState = typeof win.history.pushState === 'function' ? win.history.pushState.bind(win.history) : null;
            var originalReplaceState = typeof win.history.replaceState === 'function' ? win.history.replaceState.bind(win.history) : null;
            if (originalPushState) {{
              win.history.pushState = function() {{
                var result = originalPushState.apply(null, arguments);
                postState();
                queueMeasureFrameHeight();
                return result;
              }};
            }}
            if (originalReplaceState) {{
              win.history.replaceState = function() {{
                var result = originalReplaceState.apply(null, arguments);
                postState();
                queueMeasureFrameHeight();
                return result;
              }};
            }}
          }}
        }}

        frame.addEventListener('load', function() {{
          installFrameObservers();
          queueMeasureFrameHeight();
          setTimeout(queueMeasureFrameHeight, 120);
          setTimeout(queueMeasureFrameHeight, 400);
        }});

        window.__clawdexDesktopFrame = {{
          goBack: function() {{
            var win = currentFrameWindow();
            if (win) {{
              win.history.back();
            }}
          }},
          goForward: function() {{
            var win = currentFrameWindow();
            if (win) {{
              win.history.forward();
            }}
          }},
          reload: function() {{
            lastPostedStateJson = '';
            var win = currentFrameWindow();
            if (win) {{
              win.location.reload();
            }} else {{
              frame.src = frame.src;
            }}
          }},
        }};

        applyLayout(minimumDesktopHeight);
        frame.src = frameSrc;
      }})();
    </script>
  </body>
</html>"#
    );

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "text/html; charset=utf-8")
        .header(CACHE_CONTROL, "no-store, private")
        .header(REFERRER_POLICY, "no-referrer")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::from(String::new())))
}

pub(super) fn should_rewrite_preview_html_response(headers: &HeaderMap) -> bool {
    let Some(content_type) = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let normalized = content_type.to_ascii_lowercase();
    if !normalized.contains("text/html") && !normalized.contains("application/xhtml+xml") {
        return false;
    }

    !matches!(headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        , Some(value) if !value.is_empty() && value != "identity")
}

pub(super) fn rewrite_preview_html_document(
    body: &[u8],
    viewport: Option<PreviewViewportConfig>,
) -> Option<Vec<u8>> {
    if body.len() > PREVIEW_BUFFERED_RESPONSE_MAX_BYTES {
        return None;
    }

    let document = std::str::from_utf8(body).ok()?;
    let document =
        if let Some(content) = viewport.and_then(PreviewViewportConfig::viewport_meta_content) {
            inject_preview_viewport_meta(document, &content)
        } else {
            document.to_string()
        };
    let rewritten = inject_preview_runtime_script(&document);
    Some(rewritten.into_bytes())
}

pub(super) fn inject_preview_viewport_meta(document: &str, content: &str) -> String {
    let replacement = format!(r#"<meta name="viewport" content="{content}">"#);
    let lower = document.to_ascii_lowercase();

    let mut search_start = 0usize;
    while let Some(meta_start_relative) = lower[search_start..].find("<meta") {
        let meta_start = search_start + meta_start_relative;
        let Some(meta_end_relative) = lower[meta_start..].find('>') else {
            break;
        };
        let meta_end = meta_start + meta_end_relative + 1;
        let normalized_meta_tag = lower[meta_start..meta_end]
            .split_whitespace()
            .collect::<String>();
        if normalized_meta_tag.contains("name=\"viewport\"")
            || normalized_meta_tag.contains("name='viewport'")
            || normalized_meta_tag.contains("name=viewport")
        {
            let mut rewritten = String::with_capacity(document.len() + replacement.len());
            rewritten.push_str(&document[..meta_start]);
            rewritten.push_str(&replacement);
            rewritten.push_str(&document[meta_end..]);
            return rewritten;
        }
        search_start = meta_end;
    }

    inject_preview_head_markup(document, &replacement)
}

pub(super) fn inject_preview_runtime_script(document: &str) -> String {
    if document.contains(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH) {
        return document.to_string();
    }

    let script_tag = format!(r#"<script src="{BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH}"></script>"#);
    inject_preview_head_markup(document, &script_tag)
}

pub(super) fn inject_preview_head_markup(document: &str, markup: &str) -> String {
    let lower = document.to_ascii_lowercase();

    if let Some(head_start) = lower.find("<head") {
        if let Some(head_tag_end_relative) = lower[head_start..].find('>') {
            let insert_at = head_start + head_tag_end_relative + 1;
            let mut rewritten = String::with_capacity(document.len() + markup.len());
            rewritten.push_str(&document[..insert_at]);
            rewritten.push_str(markup);
            rewritten.push_str(&document[insert_at..]);
            return rewritten;
        }
    }

    if let Some(head_end) = lower.find("</head>") {
        let mut rewritten = String::with_capacity(document.len() + markup.len());
        rewritten.push_str(&document[..head_end]);
        rewritten.push_str(markup);
        rewritten.push_str(&document[head_end..]);
        return rewritten;
    }

    format!("{markup}{document}")
}

pub(super) fn build_preview_runtime_script() -> String {
    format!(
        r#"(function() {{
  if (globalThis.__clawdexPreviewRuntimeInstalled) {{
    return;
  }}
  globalThis.__clawdexPreviewRuntimeInstalled = true;

  var LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  var PROXY_PREFIX = "{proxy_prefix}";
  var currentOrigin = globalThis.location ? globalThis.location.origin : "";
  var currentHref = globalThis.location ? globalThis.location.href : currentOrigin;
  var wsOrigin = currentOrigin.replace(/^http/, "ws");

  function isLoopbackHost(hostname, host) {{
    return LOOPBACK_HOSTS.has((hostname || "").toLowerCase()) || LOOPBACK_HOSTS.has((host || "").toLowerCase());
  }}

  function encodeToken(value) {{
    return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }}

  function toProxyUrl(input) {{
    try {{
      var resolved = input instanceof URL ? new URL(input.toString()) : new URL(String(input), currentHref);
      if (!/^https?:$/.test(resolved.protocol) || !isLoopbackHost(resolved.hostname, resolved.host)) {{
        return null;
      }}
      var token = encodeToken(resolved.origin);
      return currentOrigin + PROXY_PREFIX + "/" + token + resolved.pathname + resolved.search + resolved.hash;
    }} catch (_error) {{
      return null;
    }}
  }}

  function toProxyWebSocketUrl(input) {{
    try {{
      var resolved = input instanceof URL ? new URL(input.toString()) : new URL(String(input), currentHref);
      if (!/^wss?:$/.test(resolved.protocol) || !isLoopbackHost(resolved.hostname, resolved.host)) {{
        return null;
      }}
      var httpOrigin = resolved.origin.replace(/^ws/, "http");
      var token = encodeToken(httpOrigin);
      return wsOrigin + PROXY_PREFIX + "/" + token + resolved.pathname + resolved.search + resolved.hash;
    }} catch (_error) {{
      return null;
    }}
  }}

  if (typeof globalThis.fetch === "function") {{
    var originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = function(input, init) {{
      var sourceUrl = input && typeof input === "object" && "url" in input ? input.url : input;
      var rewritten = toProxyUrl(sourceUrl);
      if (!rewritten) {{
        return originalFetch(input, init);
      }}
      if (typeof Request === "function" && input instanceof Request) {{
        return originalFetch(new Request(rewritten, input), init);
      }}
      return originalFetch(rewritten, init);
    }};
  }}

  if (typeof XMLHttpRequest === "function") {{
    var originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {{
      var rewritten = toProxyUrl(url);
      arguments[1] = rewritten || url;
      return originalOpen.apply(this, arguments);
    }};
  }}

  if (typeof EventSource === "function") {{
    var OriginalEventSource = EventSource;
    globalThis.EventSource = new Proxy(OriginalEventSource, {{
      construct(target, args, newTarget) {{
        var url = args[0];
        var config = args[1];
        var rewritten = toProxyUrl(url) || url;
        return config === undefined
          ? Reflect.construct(target, [rewritten], newTarget)
          : Reflect.construct(target, [rewritten, config], newTarget);
      }},
    }});
  }}

  if (typeof WebSocket === "function") {{
    var OriginalWebSocket = WebSocket;
    globalThis.WebSocket = new Proxy(OriginalWebSocket, {{
      construct(target, args, newTarget) {{
        var url = args[0];
        var protocols = args[1];
        var rewritten = toProxyWebSocketUrl(url) || url;
        return protocols === undefined
          ? Reflect.construct(target, [rewritten], newTarget)
          : Reflect.construct(target, [rewritten, protocols], newTarget);
      }},
    }});
  }}

  if (globalThis.navigator && typeof globalThis.navigator.sendBeacon === "function") {{
    var originalSendBeacon = globalThis.navigator.sendBeacon.bind(globalThis.navigator);
    globalThis.navigator.sendBeacon = function(url, data) {{
      return originalSendBeacon(toProxyUrl(url) || url, data);
    }};
  }}

  if (globalThis.document && typeof globalThis.document.addEventListener === "function") {{
    globalThis.document.addEventListener("submit", function(event) {{
      var form = event && event.target;
      if (!form || typeof form.getAttribute !== "function") {{
        return;
      }}
      var action = form.getAttribute("action");
      if (!action) {{
        return;
      }}
      var rewritten = toProxyUrl(action);
      if (rewritten) {{
        form.setAttribute("action", rewritten);
      }}
    }}, true);
  }}
}})();"#,
        proxy_prefix = BROWSER_PREVIEW_PROXY_PREFIX
    )
}

#[derive(Debug, Clone)]
pub(super) struct PreviewRequestTarget {
    pub(super) target_url: Url,
    pub(super) path_and_query: String,
    pub(super) proxy_path_prefix: Option<String>,
}

pub(super) fn resolve_preview_request_target(
    session_target_url: &Url,
    sanitized_path_and_query: &str,
) -> Result<PreviewRequestTarget, String> {
    let parsed = Url::parse(&format!("http://preview{}", sanitized_path_and_query))
        .map_err(|error| error.to_string())?;
    let path = parsed.path();
    let proxy_prefix_with_slash = format!("{BROWSER_PREVIEW_PROXY_PREFIX}/");

    if let Some(proxy_tail) = path.strip_prefix(&proxy_prefix_with_slash) {
        let mut segments = proxy_tail.splitn(2, '/');
        let target_token = segments.next().unwrap_or_default().trim();
        if target_token.is_empty() {
            return Err("missing proxied preview target".to_string());
        }

        let target_url = decode_preview_proxy_origin_token(target_token)?;
        let remainder = segments.next().unwrap_or_default();
        let proxied_path = if remainder.is_empty() {
            "/".to_string()
        } else {
            format!("/{remainder}")
        };
        let path_and_query = format!(
            "{}{}",
            proxied_path,
            parsed
                .query()
                .map(|value| format!("?{value}"))
                .unwrap_or_default()
        );

        return Ok(PreviewRequestTarget {
            target_url,
            path_and_query,
            proxy_path_prefix: Some(format!("{BROWSER_PREVIEW_PROXY_PREFIX}/{target_token}")),
        });
    }

    Ok(PreviewRequestTarget {
        target_url: session_target_url.clone(),
        path_and_query: sanitized_path_and_query.to_string(),
        proxy_path_prefix: None,
    })
}

pub(super) fn decode_preview_proxy_origin_token(token: &str) -> Result<Url, String> {
    let decoded = general_purpose::URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|error| format!("invalid proxied preview target: {error}"))?;
    let origin = String::from_utf8(decoded)
        .map_err(|_| "invalid proxied preview target encoding".to_string())?;
    let mut url = normalize_browser_preview_target_url(&origin).map_err(|error| error.message)?;
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

pub(super) fn build_preview_upstream_url(
    target_url: &Url,
    sanitized_path_and_query: &str,
    websocket: bool,
) -> Result<Url, String> {
    let parsed_path = Url::parse(&format!("http://preview{}", sanitized_path_and_query))
        .map_err(|error| error.to_string())?;
    let mut upstream_url = target_url.clone();
    if websocket {
        let scheme = if target_url.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        upstream_url
            .set_scheme(scheme)
            .map_err(|_| "failed to rewrite websocket scheme".to_string())?;
    }
    upstream_url.set_path(parsed_path.path());
    upstream_url.set_query(parsed_path.query());
    Ok(upstream_url)
}

pub(super) fn is_websocket_upgrade_request(method: &Method, headers: &HeaderMap) -> bool {
    method == Method::GET
        && headers
            .get(CONNECTION)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_ascii_lowercase().contains("upgrade"))
            .unwrap_or(false)
        && headers
            .get(UPGRADE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
}

pub(super) fn to_reqwest_method(method: &Method) -> HttpMethod {
    HttpMethod::from_bytes(method.as_str().as_bytes()).unwrap_or(HttpMethod::GET)
}

pub(super) fn should_skip_preview_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "connection"
            | "upgrade"
            | "content-length"
            | "accept-encoding"
            | "transfer-encoding"
            | "proxy-connection"
    )
}

pub(super) fn should_skip_preview_websocket_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "connection"
            | "upgrade"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-extensions"
            | "content-length"
            | "transfer-encoding"
            | "proxy-connection"
    )
}

pub(super) fn should_skip_preview_response_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "content-length"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

pub(super) fn filter_preview_cookie_header(value: &HeaderValue) -> Option<HeaderValue> {
    let raw = value.to_str().ok()?;
    let filtered = raw
        .split(';')
        .filter_map(|segment| {
            let trimmed = segment.trim();
            let (cookie_name, _) = trimmed.split_once('=')?;
            if cookie_name.trim() == BROWSER_PREVIEW_COOKIE_NAME
                || cookie_name.trim() == BROWSER_PREVIEW_VIEWPORT_COOKIE_NAME
            {
                return None;
            }
            Some(trimmed.to_string())
        })
        .collect::<Vec<_>>()
        .join("; ");

    if filtered.is_empty() {
        return None;
    }

    HeaderValue::from_str(&filtered).ok()
}

pub(super) fn rewrite_preview_request_header(
    name: &str,
    value: &HeaderValue,
    target_url: &Url,
) -> Option<HeaderValue> {
    if name.eq_ignore_ascii_case(ORIGIN.as_str()) {
        return HeaderValue::from_str(&target_origin_string(target_url)).ok();
    }

    if name.eq_ignore_ascii_case(REFERER.as_str()) {
        let raw = value.to_str().ok()?;
        let Ok(mut referer) = Url::parse(raw) else {
            return None;
        };
        let _ = referer.set_scheme(target_url.scheme());
        let _ = referer.set_host(target_url.host_str());
        let _ = referer.set_port(target_url.port());
        let retained_pairs = referer
            .query_pairs()
            .filter(|(key, _)| !matches!(key.as_ref(), "sid" | "st"))
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        referer.set_query(None);
        if !retained_pairs.is_empty() {
            let mut query = referer.query_pairs_mut();
            query.extend_pairs(retained_pairs);
        }
        return HeaderValue::from_str(referer.as_str()).ok();
    }

    Some(value.clone())
}

pub(super) fn apply_preview_security_headers(response: &mut Response) {
    response
        .headers_mut()
        .insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
}

pub(super) fn rewrite_preview_location_header(
    value: &HeaderValue,
    current_upstream_url: &Url,
    request_host: Option<&str>,
    proxy_path_prefix: Option<&str>,
) -> Option<HeaderValue> {
    let raw = value.to_str().ok()?;
    let location_url = match Url::parse(raw) {
        Ok(url) => url,
        Err(_) => match current_upstream_url.join(raw) {
            Ok(url) => url,
            Err(_) => return Some(value.clone()),
        },
    };
    if location_url.scheme() != current_upstream_url.scheme()
        || location_url.host_str() != current_upstream_url.host_str()
        || location_url.port_or_known_default() != current_upstream_url.port_or_known_default()
    {
        return Some(value.clone());
    }

    let request_host = request_host?.trim();
    let path_prefix = proxy_path_prefix.unwrap_or_default();
    let rewritten = format!(
        "http://{}{}{}{}{}",
        request_host,
        path_prefix,
        location_url.path(),
        location_url
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default(),
        location_url
            .fragment()
            .map(|fragment| format!("#{fragment}"))
            .unwrap_or_default()
    );
    HeaderValue::from_str(&rewritten).ok()
}

pub(super) fn rewrite_preview_set_cookie_header(
    value: &HeaderValue,
    proxy_path_prefix: Option<&str>,
) -> Option<HeaderValue> {
    let raw = value.to_str().ok()?;
    let mut segments = raw.split(';');
    let cookie_pair = segments.next()?.trim();
    if cookie_pair.is_empty() {
        return None;
    }

    let mut rewritten_segments = vec![cookie_pair.to_string()];
    let mut saw_path = false;

    for segment in segments {
        let trimmed = segment.trim();
        if trimmed.is_empty() {
            continue;
        }

        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("domain=") {
            continue;
        }

        if lower.starts_with("path=") {
            saw_path = true;
            let raw_path = trimmed[5..].trim();
            if let Some(path_prefix) = proxy_path_prefix {
                let normalized_path = if raw_path.starts_with('/') {
                    format!("{path_prefix}{raw_path}")
                } else {
                    format!("{path_prefix}/{raw_path}")
                };
                rewritten_segments.push(format!("Path={normalized_path}"));
            } else {
                rewritten_segments.push(trimmed.to_string());
            }
            continue;
        }

        rewritten_segments.push(trimmed.to_string());
    }

    if !saw_path {
        if let Some(path_prefix) = proxy_path_prefix {
            rewritten_segments.push(format!("Path={path_prefix}/"));
        }
    }

    HeaderValue::from_str(&rewritten_segments.join("; ")).ok()
}

pub(super) fn append_vary_header_value(headers: &mut HeaderMap, token: &str) {
    let normalized_token = token.trim();
    if normalized_token.is_empty() {
        return;
    }

    let existing = headers
        .get(VARY)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let has_token = existing
        .split(',')
        .any(|segment| segment.trim().eq_ignore_ascii_case(normalized_token));
    if has_token {
        return;
    }

    let merged = if existing.trim().is_empty() {
        normalized_token.to_string()
    } else {
        format!("{existing}, {normalized_token}")
    };
    if let Ok(value) = HeaderValue::from_str(&merged) {
        headers.insert(VARY, value);
    }
}

pub(super) fn target_origin_string(target_url: &Url) -> String {
    let explicit_port = target_url.port();
    if let Some(explicit_port) = explicit_port {
        format!(
            "{}://{}:{}",
            target_url.scheme(),
            target_url.host_str().unwrap_or("127.0.0.1"),
            explicit_port
        )
    } else {
        format!(
            "{}://{}",
            target_url.scheme(),
            target_url.host_str().unwrap_or("127.0.0.1")
        )
    }
}

pub(super) fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
