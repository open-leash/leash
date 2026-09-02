import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:crypto/crypto.dart' as crypto;
import 'package:url_launcher/url_launcher.dart';

import 'openleash_public_config.dart';
import 'feature_presentations.g.dart';

const _productionCloudApiUrl = openLeashPublicCloudApiUrl;
const _redirectUri = openLeashAuthCallbackUri;
const _privacyUrl = 'https://openleash.com/privacy';
const _supportUrl = 'https://openleash.com/support';
const _deleteAccountUrl = 'https://openleash.com/account/delete';
const _storageKey = 'openleash.mobile.session.v1';
const _functionHeader = 'x-openleash-api-function';
const _versionHeader = 'x-openleash-api-version';
const _contracts = <String, String>{
  'mobileBootstrap': '2026-05-22.mobile-bootstrap.v1',
  'mobileAuthStart': '2026-05-22.mobile-auth-start.v1',
  'mobileAuthExchange': '2026-05-22.mobile-auth-exchange.v1',
  'mobileDeviceRegister': '2026-05-22.mobile-device-register.v1',
  'mobileState': '2026-05-22.mobile-state.v1',
  'clientEvents': '2026-07-27.client-events.v1',
  'agentMonitoring': '2026-05-22.mobile-state.v1',
  'mobileDecisionResolve': '2026-05-22.mobile-decision-resolve.v1',
  'tenantPluginsRead': '2026-06-20.tenant-plugins-read.v1',
  'authAccountOutcomes': '2026-06-24.auth-account-outcomes.v1',
  'adminPluginsWrite': '2026-06-20.admin-plugins-write.v1',
};

class _OlTheme {
  static const bg = Color(0xff050607);
  static const bg2 = Color(0xff0d1013);
  static const surface = Color(0xff090b0d);
  static const surfaceRaised = Color(0xff111418);
  static const line = Color(0xff24282d);
  static const line2 = Color(0xff343940);
  static const ink = Color(0xfff6f7f8);
  static const ink2 = Color(0xffd4d7db);
  static const dim = Color(0xff999da4);
  static const mute = Color(0xff686d75);
  static const accent = Color(0xffa58af7);
  static const accent2 = Color(0xff7656df);
  static const accentSoft = Color(0xff171327);
  static const attention = Color(0xffffaa2b);
  static const attentionSoft = Color(0xff1b1206);
  static const danger = Color(0xffff5b52);
  static const dangerSoft = Color(0xff2b100f);
  static const ok = Color(0xff4be0a3);
  static const okSoft = Color(0xff0c271e);

  static const panelShadow = [
    BoxShadow(color: Color(0x99000000), blurRadius: 28, offset: Offset(0, 14)),
  ];
}

String _defaultCloudApiUrl() {
  const configured = String.fromEnvironment('OPENLEASH_CLOUD_API_URL');
  if (configured.isNotEmpty) return configured;
  if (kDebugMode) {
    if (Platform.isAndroid) return 'http://10.0.2.2:9318';
    return 'http://localhost:9318';
  }
  return _productionCloudApiUrl;
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final notifications = ApprovalNotifications();
  await notifications.init();
  runApp(LeashMobileApp(notifications: notifications));
}

class LeashMobileApp extends StatelessWidget {
  const LeashMobileApp({super.key, required this.notifications});

  final ApprovalNotifications notifications;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Leash',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: _OlTheme.bg,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _OlTheme.accent,
          brightness: Brightness.dark,
          primary: _OlTheme.accent,
          secondary: _OlTheme.accent,
          surface: _OlTheme.surface,
          error: _OlTheme.danger,
        ),
        fontFamily: Platform.isIOS ? 'SF Pro Display' : null,
        textTheme: Theme.of(
          context,
        ).textTheme.apply(bodyColor: _OlTheme.ink, displayColor: _OlTheme.ink),
        dividerTheme: const DividerThemeData(color: _OlTheme.line),
        progressIndicatorTheme: const ProgressIndicatorThemeData(
          color: _OlTheme.accent,
          linearTrackColor: _OlTheme.accentSoft,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: _OlTheme.bg2,
          hintStyle: const TextStyle(color: _OlTheme.mute),
          counterStyle: const TextStyle(color: _OlTheme.mute),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: _OlTheme.line2),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: _OlTheme.line2),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: _OlTheme.accent, width: 1.3),
          ),
        ),
      ),
      builder: (context, child) {
        final media = MediaQuery.of(context);
        return MediaQuery(
          data: media.copyWith(
            textScaler: media.textScaler.clamp(
              minScaleFactor: 0.88,
              maxScaleFactor: Platform.isIOS ? 0.92 : 0.96,
            ),
          ),
          child: child ?? const SizedBox.shrink(),
        );
      },
      home: LeashHome(notifications: notifications),
    );
  }
}

class LeashHome extends StatefulWidget {
  const LeashHome({super.key, required this.notifications});

  final ApprovalNotifications notifications;

  @override
  State<LeashHome> createState() => _LeashHomeState();
}

class _LeashHomeState extends State<LeashHome> {
  final _storage = const FlutterSecureStorage();
  final _appLinks = AppLinks();
  final _apiController = TextEditingController(text: _defaultCloudApiUrl());
  final _deviceId = DateTime.now().microsecondsSinceEpoch.toString();
  StreamSubscription<Uri>? _linkSub;
  Timer? _poller;
  http.Client? _eventClient;
  int _eventStreamGeneration = 0;

  bool _loading = true;
  bool _customApi = false;
  bool _busy = false;
  bool _notificationSounds = true;
  String _audience = 'individual';
  String? _error;
  String? _token;
  String? _pendingProvider;
  String? _pendingOrganizationId;
  String? _pendingExchangeRedirectUri;
  String? _pendingAuthState;
  String? _pendingCodeVerifier;
  Map<String, dynamic>? _bootstrap;
  Map<String, dynamic>? _state;
  Map<String, dynamic>? _billing;
  bool _trialEndedNotified = false;
  final Set<String> _notifiedApprovalIds = {};
  final Set<String> _notifiedAttentionIds = {};
  bool _loadedAttentionOnce = false;
  int _historyVisibleCount = 10;
  int _historyPage = 1;
  bool _historyHasMore = false;
  bool _historyLoading = false;
  String? _historyError;
  final List<Map<String, dynamic>> _historyItems = [];

  String get _apiUrl =>
      _apiController.text.trim().replaceAll(RegExp(r'/$'), '');
  List<String> get _apiCandidates {
    if (_customApi) return [_apiUrl];
    final localDevCandidates = kDebugMode
        ? Platform.isAndroid
              ? const ['http://10.0.2.2:9318', 'http://localhost:9318']
              : const ['http://localhost:9318', 'http://127.0.0.1:9318']
        : const <String>[];
    return <String>{
      _defaultCloudApiUrl(),
      ...localDevCandidates,
      _productionCloudApiUrl,
    }.toList();
  }

  bool get _signedIn => _token != null && _token!.isNotEmpty;
  List<dynamic> get _providers =>
      (_bootstrap?['providers'] as List?) ?? const [];
  List<dynamic> get _pendingApprovals =>
      (_state?['pendingApprovals'] as List?) ?? const [];
  List<dynamic> get _attentionEvents =>
      (_state?['attentionEvents'] as List?) ?? const [];
  List<dynamic> get _agents => (_state?['agents'] as List?) ?? const [];
  List<dynamic> get _plugins => (_state?['plugins'] as List?) ?? const [];
  List<dynamic> get _outcomes => (_state?['outcomes'] as List?) ?? const [];
  List<dynamic> get _recentActivity => _historyItems.isNotEmpty
      ? _historyItems
      : ((_state?['recentActivity'] as List?) ?? const []);

  @override
  void initState() {
    super.initState();
    widget.notifications.onDecision = _resolveFromNotification;
    _linkSub = _appLinks.uriLinkStream.listen(_handleIncomingLink);
    _restore();
  }

  @override
  void dispose() {
    _poller?.cancel();
    _stopLiveEvents();
    _linkSub?.cancel();
    _apiController.dispose();
    super.dispose();
  }

  Future<void> _restore() async {
    final raw = await _storage.read(key: _storageKey);
    if (raw != null) {
      final saved = jsonDecode(raw) as Map<String, dynamic>;
      _customApi = saved['customApi'] == true;
      final savedApiUrl = saved['apiUrl'] as String?;
      _apiController.text = _customApi
          ? savedApiUrl ?? _defaultCloudApiUrl()
          : _defaultCloudApiUrl();
      _token = saved['token'] as String?;
      _notificationSounds = saved['notificationSounds'] != false;
    }
    widget.notifications.soundsEnabled = _notificationSounds;
    if (_signedIn) {
      final bootstrapped = await _bootstrapApi();
      if (!bootstrapped) {
        if (mounted) setState(() => _loading = false);
        return;
      }
      await _registerDevice();
      await _refreshState(showNotifications: true);
      await _refreshBilling(showNotification: true);
      _startPolling();
      _startLiveEvents();
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _save() async {
    await _storage.write(
      key: _storageKey,
      value: jsonEncode({
        'apiUrl': _apiUrl,
        'customApi': _customApi,
        'token': _token,
        'notificationSounds': _notificationSounds,
      }),
    );
  }

  Future<void> _setNotificationSounds(bool enabled) async {
    setStateSafe(() => _notificationSounds = enabled);
    widget.notifications.soundsEnabled = enabled;
    await _save();
  }

  Map<String, String> _headers(String functionName, {bool json = false}) {
    return {
      _functionHeader: functionName,
      _versionHeader: _contracts[functionName]!,
      if (json) 'content-type': 'application/json',
      if (_token != null) 'authorization': 'Bearer $_token',
    };
  }

  Future<http.Response> _request(
    String method,
    String path,
    String functionName, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
  }) async {
    final uri = Uri.parse('$_apiUrl$path').replace(queryParameters: query);
    final headers = _headers(functionName, json: body != null);
    if (method == 'POST') {
      return http.post(uri, headers: headers, body: jsonEncode(body ?? {}));
    }
    return http.get(uri, headers: headers);
  }

  Future<bool> _bootstrapApi() async {
    setStateSafe(() {
      _busy = true;
      _error = null;
    });
    Object? lastError;
    try {
      for (final candidate in _apiCandidates) {
        _apiController.text = candidate;
        try {
          final response = await _request(
            'GET',
            '/v1/mobile/bootstrap',
            'mobileBootstrap',
          );
          if (response.statusCode >= 400) {
            throw Exception(await _responseMessage(response));
          }
          _bootstrap = jsonDecode(response.body) as Map<String, dynamic>;
          await _save();
          return true;
        } catch (error) {
          lastError = error;
        }
      }
      _error =
          'Could not reach Leash at ${_apiCandidates.join(' or ')}. Check that the API is running and try again.';
      return false;
    } catch (error) {
      _error = 'Could not connect to Leash. ${_cleanError(lastError ?? error)}';
      return false;
    } finally {
      setStateSafe(() => _busy = false);
    }
  }

  Future<void> _startSignIn([String? providerOverride]) async {
    setStateSafe(() {
      _busy = true;
      _error = null;
    });
    try {
      if (!await _bootstrapApi()) return;
      final provider = providerOverride != null
          ? {'type': providerOverride}
          : _providers.isNotEmpty
          ? _providers.first as Map<String, dynamic>
          : {'type': 'google'};
      _pendingProvider =
          provider['type'] as String? ??
          provider['providerType'] as String? ??
          'google';
      _pendingOrganizationId = null;
      _audience = 'individual';
      final secureRandom = Random.secure();
      final verifierBytes = List<int>.generate(
        32,
        (_) => secureRandom.nextInt(256),
      );
      _pendingCodeVerifier = base64UrlEncode(verifierBytes).replaceAll('=', '');
      final codeChallenge = base64UrlEncode(
        crypto.sha256.convert(utf8.encode(_pendingCodeVerifier!)).bytes,
      ).replaceAll('=', '');
      final response = await _request(
        'POST',
        '/v1/mobile/auth/start',
        'mobileAuthStart',
        body: {
          'redirectUri': _redirectUri,
          'audience': _audience,
          'providerType': _pendingProvider,
          'organizationId': _pendingOrganizationId,
          'codeChallenge': codeChallenge,
          'codeChallengeMethod': 'S256',
        },
      );
      if (response.statusCode >= 400) {
        throw Exception(await _responseMessage(response));
      }
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      _pendingExchangeRedirectUri =
          data['exchangeRedirectUri'] as String? ?? _redirectUri;
      _pendingAuthState = data['state'] as String?;
      if (_pendingAuthState == null || _pendingAuthState!.length < 32) {
        throw Exception('The API did not return a secure sign-in state.');
      }
      final url = Uri.parse(data['authorizationUrl'] as String);
      if (!await launchUrl(url, mode: LaunchMode.externalApplication)) {
        throw Exception('Could not open identity provider.');
      }
    } catch (error) {
      final message = _cleanError(error);
      _error =
          message.contains('OPENLEASH_GOOGLE_CLIENT_ID') ||
              message.contains('Cloud Google login is not configured')
          ? 'Google sign-in is not configured on this API yet.'
          : 'Could not start Google sign-in. $message';
    } finally {
      setStateSafe(() => _busy = false);
    }
  }

  Future<void> _handleIncomingLink(Uri uri) async {
    if (uri.scheme != 'openleash' || uri.host != 'auth') return;
    final error =
        uri.queryParameters['error_description'] ??
        uri.queryParameters['error'];
    if (error != null && error.isNotEmpty) {
      setStateSafe(() => _error = 'Google sign-in did not complete. $error');
      return;
    }
    final exchangeRedirectUri = uri.queryParameters['exchangeRedirectUri'];
    _audience = 'individual';
    if (exchangeRedirectUri != null && exchangeRedirectUri.isNotEmpty) {
      _pendingExchangeRedirectUri = exchangeRedirectUri;
    }
    final code = uri.queryParameters['code'];
    final state = uri.queryParameters['state'];
    if (state == null || state != _pendingAuthState) {
      setStateSafe(
        () =>
            _error = 'This sign-in request expired or does not match this app.',
      );
      return;
    }
    if (code == null || code.isEmpty) {
      setStateSafe(
        () => _error = 'Sign-in was cancelled or returned without a code.',
      );
      return;
    }
    final pendingState = _pendingAuthState;
    final pendingCodeVerifier = _pendingCodeVerifier;
    _pendingAuthState = null;
    _pendingCodeVerifier = null;
    if (pendingCodeVerifier == null || pendingCodeVerifier.length < 43) {
      setStateSafe(
        () => _error = 'This sign-in request is no longer bound to this app.',
      );
      return;
    }
    await _exchangeCode(code, pendingState!, pendingCodeVerifier);
  }

  Future<void> _exchangeCode(
    String code,
    String state,
    String codeVerifier,
  ) async {
    setStateSafe(() {
      _busy = true;
      _error = null;
    });
    try {
      final response = await _request(
        'POST',
        '/v1/mobile/auth/exchange',
        'mobileAuthExchange',
        body: {
          'redirectUri': _pendingExchangeRedirectUri ?? _redirectUri,
          'audience': _audience,
          'authorizationCode': code,
          'state': state,
          'codeVerifier': codeVerifier,
          'providerType': _pendingProvider ?? 'google',
          'organizationId': _pendingOrganizationId,
          'provisionUser': false,
        },
      );
      if (response.statusCode >= 400) {
        throw Exception(await _responseMessage(response));
      }
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      _token =
          data['token'] as String? ??
          data['sessionToken'] as String? ??
          data['session']?['token'] as String? ??
          data['tokens']?['accessToken'] as String?;
      if (_token == null) throw Exception('No session token returned.');
      await _save();
      await _registerDevice();
      await _refreshState(showNotifications: true);
      await _refreshBilling(showNotification: true);
      _startPolling();
      _startLiveEvents();
    } catch (error) {
      _error =
          'Sign-in completed, but Leash could not create the mobile session. ${_cleanError(error)}';
    } finally {
      setStateSafe(() => _busy = false);
    }
  }

  Future<void> _registerDevice() async {
    if (!_signedIn) return;
    await widget.notifications.requestPermissions();
    try {
      await _request(
        'POST',
        '/v1/mobile/devices',
        'mobileDeviceRegister',
        body: {
          'platform': Platform.isIOS ? 'ios' : 'android',
          'pushToken': 'local-polling:$_deviceId',
          'deviceName': Platform.localHostname,
          'appVersion': '1.0.0',
        },
      );
    } catch (_) {
      // Polling still works even if registration fails during local development.
    }
  }

  void _startPolling() {
    _poller?.cancel();
    _poller = Timer.periodic(const Duration(seconds: 15), (_) {
      unawaited(_refreshState(showNotifications: true));
      unawaited(_refreshBilling(showNotification: true));
    });
  }

  void _startLiveEvents() {
    _stopLiveEvents();
    if (!_signedIn) return;
    final generation = ++_eventStreamGeneration;
    final client = http.Client();
    _eventClient = client;
    unawaited(_consumeLiveEvents(client, generation));
  }

  void _stopLiveEvents() {
    _eventStreamGeneration++;
    _eventClient?.close();
    _eventClient = null;
  }

  Future<void> _consumeLiveEvents(http.Client client, int generation) async {
    while (mounted &&
        _signedIn &&
        generation == _eventStreamGeneration &&
        identical(client, _eventClient)) {
      try {
        final request = http.Request(
          'GET',
          Uri.parse('$_apiUrl/v1/client/events'),
        );
        request.headers.addAll({
          ..._headers('clientEvents'),
          'accept': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        final response = await client.send(request);
        if (response.statusCode >= 400) {
          throw Exception('Live updates returned HTTP ${response.statusCode}');
        }
        await for (final line
            in response.stream
                .transform(utf8.decoder)
                .transform(const LineSplitter())) {
          if (generation != _eventStreamGeneration || !_signedIn) return;
          if (line.startsWith('data:')) {
            unawaited(_refreshState(showNotifications: true));
          }
        }
      } catch (_) {
        if (generation != _eventStreamGeneration || !_signedIn) return;
      }
      await Future<void>.delayed(const Duration(seconds: 2));
    }
  }

  Future<void> _refreshState({bool showNotifications = false}) async {
    if (!_signedIn) return;
    try {
      final response = await _request('GET', '/v1/mobile/state', 'mobileState');
      if (response.statusCode == 401) {
        await _signOut();
        return;
      }
      if (response.statusCode >= 400) throw Exception(response.body);
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      setStateSafe(() {
        _state = data;
        final newest = ((data['recentActivity'] as List?) ?? const [])
            .whereType<Map>()
            .map((item) => Map<String, dynamic>.from(item));
        final byId = <String, Map<String, dynamic>>{
          for (final item in [...newest, ..._historyItems])
            if (item['id'] != null) item['id'].toString(): item,
        };
        _historyItems
          ..clear()
          ..addAll(byId.values);
        final pagination = data['historyPagination'];
        if (pagination is Map && _historyPage <= 1) {
          _historyHasMore = pagination['hasMore'] == true;
          _historyPage = 1;
        }
      });
      final clientConfig = data['clientConfig'];
      final approvalNotifications = clientConfig is Map
          ? clientConfig['approvalNotifications'] != false
          : true;
      if (showNotifications && approvalNotifications) {
        await _showNewAttentionNotifications(data);
      }
    } catch (_) {
      setStateSafe(() => _error = 'Could not refresh approvals from the API.');
    }
  }

  Future<void> _refreshBilling({bool showNotification = false}) async {
    if (!_signedIn || _customApi) return;
    try {
      final response = await http.get(
        Uri.parse('$_apiUrl/auth/account/billing'),
        headers: {'authorization': 'Bearer $_token'},
      );
      if (response.statusCode >= 400) return;
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      setStateSafe(() => _billing = data);
      final trial = data['trial'];
      if (showNotification &&
          data['upgradeRequired'] == true &&
          trial is Map &&
          trial['expired'] == true &&
          !_trialEndedNotified) {
        _trialEndedNotified = true;
        await widget.notifications.showAttention({
          'id': 'leash-cloud-trial-ended',
          'kind': 'trial_ended',
          'title': 'Your Leash Cloud trial ended',
          'body': 'Upgrade to keep Leash AI protection active.',
          'state': 'waiting',
        }, null);
      }
    } catch (_) {
      // Billing status is supplementary; approvals keep refreshing.
    }
  }

  Future<void> _loadOlderHistory() async {
    if (_historyLoading || !_historyHasMore) return;
    setStateSafe(() {
      _historyLoading = true;
      _historyError = null;
    });
    try {
      final nextPage = _historyPage + 1;
      final response = await _request(
        'GET',
        '/v1/client/history',
        'mobileState',
        query: {'page': '$nextPage', 'limit': '10'},
      );
      if (response.statusCode >= 400) throw Exception(response.body);
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      final next = ((data['history'] as List?) ?? const [])
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item));
      setStateSafe(() {
        final ids = _historyItems
            .map((item) => item['id']?.toString())
            .whereType<String>()
            .toSet();
        _historyItems.addAll(
          next.where((item) => ids.add(item['id']?.toString() ?? '')),
        );
        _historyPage = nextPage;
        _historyHasMore = (data['pagination'] as Map?)?['hasMore'] == true;
        _historyVisibleCount = _historyItems.length;
      });
    } catch (_) {
      setStateSafe(() => _historyError = 'History could not load. Try again.');
    } finally {
      setStateSafe(() => _historyLoading = false);
    }
  }

  Future<void> _showNewAttentionNotifications(Map<String, dynamic> data) async {
    final pendingById = <String, Map>{
      for (final item
          in ((data['pendingApprovals'] as List?) ?? const []).whereType<Map>())
        if (item['id'] != null) item['id'].toString(): item,
    };
    final events = ((data['attentionEvents'] as List?) ?? const [])
        .whereType<Map>()
        .toList();
    if (events.isEmpty) {
      for (final approval in pendingById.values) {
        final id = approval['id']?.toString();
        if (id == null || _notifiedApprovalIds.contains(id)) continue;
        _notifiedApprovalIds.add(id);
        await widget.notifications.showApproval(_approvalFromMap(approval));
      }
      return;
    }
    for (final event in events) {
      final id = event['id']?.toString();
      if (id == null || _notifiedAttentionIds.contains(id)) continue;
      _notifiedAttentionIds.add(id);
      final waiting = event['state'] == 'waiting';
      if (!_loadedAttentionOnce && !waiting) continue;
      final decisionId = event['decisionId']?.toString();
      final approval = decisionId == null ? null : pendingById[decisionId];
      await widget.notifications.showAttention(
        event,
        approval == null ? null : _approvalFromMap(approval),
      );
    }
    _loadedAttentionOnce = true;
  }

  Future<bool> _setPluginInstalled(Map plugin, bool installed) async {
    final id = plugin['id']?.toString() ?? '';
    if (id.isEmpty) {
      return false;
    }
    try {
      final response = await _request(
        'POST',
        '/v1/plugins/${Uri.encodeComponent(id)}/${installed ? 'install' : 'uninstall'}',
        'adminPluginsWrite',
      );
      if (response.statusCode >= 400) {
        throw Exception(await _responseMessage(response));
      }
      await _refreshState();
      return true;
    } catch (error) {
      setStateSafe(() => _error = _cleanError(error));
      return false;
    }
  }

  Future<bool> _savePluginSettings(
    Map plugin,
    Map<String, dynamic> config,
  ) async {
    final id = plugin['id']?.toString() ?? '';
    if (id.isEmpty) {
      return false;
    }
    try {
      final response = await _request(
        'POST',
        '/v1/plugins/${Uri.encodeComponent(id)}/settings',
        'adminPluginsWrite',
        body: {'enabled': _pluginInstalled(plugin), 'config': config},
      );
      if (response.statusCode >= 400) {
        throw Exception(await _responseMessage(response));
      }
      await _refreshState();
      return true;
    } catch (error) {
      setStateSafe(() => _error = _cleanError(error));
      return false;
    }
  }

  Future<void> _setAgentMonitoring(Map agent, bool monitored) async {
    final kind = _canonicalAgentKind(agent);
    if (kind.isEmpty) return;
    final previousState = _state == null
        ? null
        : Map<String, dynamic>.from(_state as Map<String, dynamic>);
    setStateSafe(() {
      final nextState = Map<String, dynamic>.from(_state ?? const {});
      final nextAgents = ((_state?['agents'] as List?) ?? const []).map((item) {
        if (item is! Map) return item;
        if (_canonicalAgentKind(item) != kind) return item;
        return {...item, 'desired_monitored': monitored};
      }).toList();
      nextState['agents'] = nextAgents;
      _state = nextState;
    });
    try {
      final response = await _request(
        'POST',
        '/v1/agents/$kind/monitoring',
        'agentMonitoring',
        body: {'monitored': monitored},
      );
      if (response.statusCode >= 400) throw Exception(response.body);
      await _refreshState();
    } catch (_) {
      if (previousState != null) setStateSafe(() => _state = previousState);
      setStateSafe(() => _error = 'Could not update this agent.');
    }
  }

  Future<void> _resolveFromNotification(
    String id,
    String resolution,
    String? resolutionGuidance,
  ) async {
    await _resolveApproval(
      id,
      resolution,
      resolutionGuidance: resolutionGuidance,
    );
  }

  Future<void> _resolveApproval(
    String id,
    String resolution, {
    String? resolutionGuidance,
    Map<String, dynamic>? responsePayload,
  }) async {
    setStateSafe(() => _busy = true);
    try {
      final guidance = resolution == 'deny'
          ? _cleanResolutionGuidance(resolutionGuidance)
          : null;
      final body = <String, dynamic>{'resolution': resolution};
      if (guidance != null) body['resolutionGuidance'] = guidance;
      if (resolution == 'allow' && responsePayload != null) {
        body['response'] = responsePayload;
      }
      final response = await _request(
        'POST',
        '/v1/mobile/decisions/$id/resolve',
        'mobileDecisionResolve',
        body: body,
      );
      if (response.statusCode >= 400) throw Exception(response.body);
      await _refreshState();
    } catch (_) {
      setStateSafe(
        () => _error = 'Could not send your decision. Please try again.',
      );
    } finally {
      setStateSafe(() => _busy = false);
    }
  }

  Future<void> _signOut() async {
    _poller?.cancel();
    _stopLiveEvents();
    _token = null;
    _state = null;
    _billing = null;
    _trialEndedNotified = false;
    await _save();
    setStateSafe(() {});
  }

  Future<void> _openExternalPage(String url) async {
    final uri = Uri.parse(url);
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      setStateSafe(() => _error = 'Could not open $url.');
    }
  }

  void setStateSafe(VoidCallback fn) {
    if (!mounted) return;
    setState(fn);
  }

  Future<String> _responseMessage(http.Response response) async {
    try {
      final payload = jsonDecode(response.body);
      if (payload is Map) {
        final message =
            payload['message'] ?? payload['error'] ?? payload['detail'];
        final required = payload['required'];
        final suffix = required is List
            ? ' Required: ${required.join(', ')}.'
            : '';
        if (message != null) return '${message.toString()}$suffix';
      }
    } catch (_) {
      // Fall back to the raw response below.
    }
    return response.body.isNotEmpty
        ? response.body
        : 'HTTP ${response.statusCode}';
  }

  String _cleanError(Object error) {
    final text = error.toString().replaceFirst(RegExp(r'^Exception: ?'), '');
    return text.endsWith('.') ? text : '$text.';
  }

  Approval _approvalFromMap(Map approval) {
    final triggeredPolicies =
        (approval['triggered_policies'] as List?) ??
        (approval['triggeredPolicies'] as List?) ??
        const [];
    Map? firstPolicy;
    for (final item in triggeredPolicies) {
      if (item is Map) {
        firstPolicy = item;
        break;
      }
    }
    final policy =
        approval['primary_policy'] ??
        approval['primaryPolicy'] ??
        approval['policy_title'] ??
        approval['policyTitle'] ??
        firstPolicy?['policy_name'] ??
        firstPolicy?['policyName'] ??
        approval['title'];
    final project =
        approval['project_name']?.toString() ??
        approval['projectName']?.toString() ??
        _projectNameFromPath(
          approval['project_path']?.toString() ??
              approval['projectPath']?.toString(),
        );
    return Approval(
      id: approval['id']?.toString() ?? '',
      kind:
          approval['attention_kind']?.toString() ??
          approval['attentionKind']?.toString() ??
          'approval',
      interaction: approval['interaction'] is Map
          ? Map<String, dynamic>.from(approval['interaction'] as Map)
          : null,
      title: approval['summary']?.toString() ?? 'Leash approval needed',
      agent:
          approval['agent_name']?.toString() ??
          approval['agentName']?.toString() ??
          'AI agent',
      agentKind:
          approval['agent_kind']?.toString() ??
          approval['agentKind']?.toString(),
      project: project ?? 'Project',
      policy: policy?.toString() ?? 'Leash rule',
      plugin:
          approval['plugin_name']?.toString() ??
          approval['pluginName']?.toString() ??
          'Leash core',
      purpose:
          approval['purpose_summary']?.toString() ??
          approval['purposeSummary']?.toString(),
      quote:
          approval['quote']?.toString() ??
          firstPolicy?['explanation']?.toString(),
      context: _contextFromApproval(approval),
      createdAt:
          DateTime.tryParse(
            approval['created_at']?.toString() ??
                approval['createdAt']?.toString() ??
                '',
          ) ??
          DateTime.now(),
    );
  }

  String? _projectNameFromPath(String? value) {
    if (value == null || value.trim().isEmpty) return null;
    final normalized = value
        .replaceAll('\\', '/')
        .replaceAll(RegExp(r'/+$'), '');
    final parts = normalized.split('/').where((part) => part.isNotEmpty);
    return parts.isEmpty ? normalized : parts.last;
  }

  List<ApprovalContextLine> _contextFromApproval(Map approval) {
    final raw =
        (approval['recent_context'] as List?) ??
        (approval['recentContext'] as List?) ??
        const [];
    return raw
        .whereType<Map>()
        .map((item) {
          return ApprovalContextLine(
            role: item['role']?.toString() ?? 'context',
            content: item['content']?.toString() ?? '',
          );
        })
        .where((item) => item.content.trim().isNotEmpty)
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        body: Center(
          child: Padding(
            padding: EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Image(
                  image: AssetImage('assets/openleash-icon.png'),
                  width: 54,
                  height: 54,
                ),
                SizedBox(height: 22),
                CircularProgressIndicator(),
                SizedBox(height: 16),
                Text(
                  'Loading your overview',
                  style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800),
                ),
                SizedBox(height: 6),
                Text(
                  'Leash is checking for protected agents and new history.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: _OlTheme.dim, height: 1.4),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return Scaffold(
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              _OlTheme.bg,
              _OlTheme.bg2,
              Color.alphaBlend(
                _OlTheme.accent2.withValues(alpha: 0.10),
                _OlTheme.bg,
              ),
            ],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 680),
              child: RefreshIndicator(
                color: _OlTheme.accent,
                onRefresh: () => _refreshState(showNotifications: true),
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 32),
                  children: [
                    _LogoHeader(
                      signedIn: _signedIn,
                      trialLabel: _trialSettingsLabel(),
                      notificationSounds: _notificationSounds,
                      onNotificationSoundsChanged: _setNotificationSounds,
                      onSignOut: _signOut,
                      onPrivacy: () => _openExternalPage(_privacyUrl),
                      onSupport: () => _openExternalPage(_supportUrl),
                      onDeleteAccount: () =>
                          _openExternalPage(_deleteAccountUrl),
                    ),
                    SizedBox(height: _signedIn ? 20 : 18),
                    if (_error != null) _ErrorBanner(message: _error!),
                    if (_signedIn && _billing?['trial'] is Map)
                      _CloudTrialCard(billing: _billing!),
                    if (_busy) const LinearProgressIndicator(minHeight: 3),
                    if (!_signedIn) ..._wizard() else ..._approvalHome(),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  String? _trialSettingsLabel() {
    final trial = _billing?['trial'];
    if (trial is! Map) return null;
    if (_billing?['upgradeRequired'] == true) {
      return 'Cloud trial ended. Upgrade required';
    }
    if (trial['active'] == true) {
      return 'Cloud trial: ${trial['daysRemaining']} days left';
    }
    return null;
  }

  List<Widget> _wizard() {
    return [_signInLanding(), const SizedBox(height: 18)];
  }

  Widget _signInLanding() {
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Sign in to Leash',
            style: TextStyle(
              fontSize: 32,
              height: 1.02,
              letterSpacing: -1.1,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 8),
          const Text(
            'Use your personal Leash Cloud account to approve agent actions from your phone.',
            style: TextStyle(
              color: _OlTheme.dim,
              fontSize: 16,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 18),
          if (!_customApi) ...[
            _GoogleButton(
              busy: _busy,
              onPressed: () {
                setState(() => _apiController.text = _defaultCloudApiUrl());
                _startSignIn('google');
              },
            ),
            const SizedBox(height: 10),
            _ProviderButton(
              label: 'Sign in with Microsoft',
              mark: 'M',
              busy: _busy && _pendingProvider == 'azure_ad',
              onPressed: () {
                setState(() => _apiController.text = _defaultCloudApiUrl());
                _startSignIn('azure_ad');
              },
            ),
            const SizedBox(height: 10),
            _SecondaryButton(
              label: 'Use personal API',
              onPressed: () => setState(() {
                _customApi = true;
                _audience = 'individual';
              }),
            ),
          ],
          if (_customApi) ...[
            _Input(
              controller: _apiController,
              label: 'Personal Leash API URL',
              hint: 'https://your-leash-api.example',
            ),
            const SizedBox(height: 16),
            _PrimaryButton(
              label: 'Connect personal API',
              icon: Icons.arrow_forward,
              onPressed: () => _startSignIn(),
            ),
            const SizedBox(height: 10),
            _SecondaryButton(
              label: 'Use Leash Cloud',
              onPressed: () => setState(() {
                _customApi = false;
                _audience = 'individual';
                _apiController.text = _defaultCloudApiUrl();
              }),
            ),
          ],
          const SizedBox(height: 16),
          _LegalLinks(
            onPrivacy: () => _openExternalPage(_privacyUrl),
            onSupport: () => _openExternalPage(_supportUrl),
            onDeleteAccount: () => _openExternalPage(_deleteAccountUrl),
          ),
        ],
      ),
    );
  }

  List<Widget> _approvalHome() {
    final user =
        (_state?['user'] as Map?)?['name']?.toString() ??
        (_state?['user'] as Map?)?['display_name']?.toString() ??
        (_state?['user'] as Map?)?['displayName']?.toString() ??
        (_state?['user'] as Map?)?['email']?.toString() ??
        'Signed in';
    const organization = 'Personal Leash';
    final visibleAgents =
        _agents.whereType<Map>().where(_isVisibleAgent).toList()
          ..sort(_compareAgentsByCanonicalOrder);
    final sessionCount = visibleAgents.fold<int>(
      0,
      (count, agent) => count + _agentSessions(agent).length,
    );
    final sessionMetrics = (_state?['sessionMetrics'] as Map?) ?? const {};
    final allVisibleHistory = _recentActivity
        .whereType<Map>()
        .where(_isInterestingActivity)
        .toList();
    final visibleHistory = allVisibleHistory
        .take(_historyVisibleCount)
        .toList();
    final recentAttention =
        _attentionEvents
            .whereType<Map>()
            .where((event) => event['state'] == 'resolved')
            .toList()
          ..sort((a, b) {
            final left =
                DateTime.tryParse(a['createdAt']?.toString() ?? '') ??
                DateTime.fromMillisecondsSinceEpoch(0);
            final right =
                DateTime.tryParse(b['createdAt']?.toString() ?? '') ??
                DateTime.fromMillisecondsSinceEpoch(0);
            return right.compareTo(left);
          });
    final installedPlugins =
        _plugins.whereType<Map>().where(_pluginInstalled).toList()
          ..sort(_comparePlugins);
    final availablePlugins =
        _plugins
            .whereType<Map>()
            .where((plugin) => !_pluginInstalled(plugin))
            .toList()
          ..sort(_comparePlugins);
    final agentCount = visibleAgents.length;
    return [
      if (_pendingApprovals.isEmpty) ...[
        _Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const CircleAvatar(
                    radius: 24,
                    backgroundColor: _OlTheme.okSoft,
                    child: Icon(
                      Icons.verified_user_outlined,
                      color: _OlTheme.ok,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          user,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 19,
                            letterSpacing: -0.3,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          organization,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 14,
                            color: _OlTheme.dim,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    onPressed: () => _refreshState(showNotifications: true),
                    icon: const Icon(Icons.refresh),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              Row(
                children: [
                  Expanded(
                    child: _DashboardMetric(
                      value: '$agentCount',
                      label: agentCount == 1 ? 'agent' : 'agents',
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _DashboardMetric(
                      value: '${_pendingApprovals.length}',
                      label: 'pending',
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _DashboardMetric(
                      value: _formatDuration(sessionMetrics['last24h_seconds']),
                      label: '$sessionCount sessions',
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
      ],
      if (_pendingApprovals.isNotEmpty) ...[
        const _SectionTitle('Needs your attention'),
        const SizedBox(height: 8),
        ..._pendingApprovals.map((item) {
          final approval = _approvalFromMap(item as Map);
          return Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: _ApprovalCard(
              approval: approval,
              onAllow: (responsePayload) => _resolveApproval(
                approval.id,
                'allow',
                responsePayload: responsePayload,
              ),
              onDeny: (guidance) => _resolveApproval(
                approval.id,
                'deny',
                resolutionGuidance: guidance,
              ),
            ),
          );
        }),
      ],
      if (recentAttention.isNotEmpty) ...[
        const _SectionTitle('Recent notifications'),
        const SizedBox(height: 8),
        _Panel(
          child: Column(
            children: [
              for (
                var index = 0;
                index < recentAttention.take(8).length;
                index++
              ) ...[
                _AttentionEventRow(event: recentAttention[index]),
                if (index != recentAttention.take(8).length - 1)
                  const Divider(height: 18),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),
      ],
      _ActiveSessionHeader(count: sessionCount),
      const SizedBox(height: 8),
      if (visibleAgents.isEmpty)
        const _EmptyApprovals()
      else ...[
        for (final item in visibleAgents)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _AgentCard(
              agent: item,
              onMonitoringChanged: (monitored) =>
                  _setAgentMonitoring(item, monitored),
            ),
          ),
      ],
      const SizedBox(height: 16),
      _PluginHomeSection(
        plugins: installedPlugins,
        availableCount: availablePlugins.length,
        outcomes: _outcomes.whereType<Map>().toList(),
        onOpenPlugin: (plugin) => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => _PluginDetailPage(
              plugin: plugin,
              outcomes: _pluginOutcomes(
                plugin,
                _outcomes.whereType<Map>().toList(),
              ),
              onInstallChanged: (installed) =>
                  _setPluginInstalled(plugin, installed),
              onSaveSettings: (config) => _savePluginSettings(plugin, config),
            ),
          ),
        ),
        onAddPlugins: () => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => _PluginMarketplacePage(
              plugins: availablePlugins,
              outcomes: _outcomes.whereType<Map>().toList(),
              onInstallChanged: _setPluginInstalled,
              onSaveSettings: _savePluginSettings,
            ),
          ),
        ),
      ),
      const SizedBox(height: 16),
      const _SectionTitle('History'),
      const SizedBox(height: 8),
      _Panel(
        child: visibleHistory.isEmpty
            ? const Text(
                'No history yet.',
                style: TextStyle(
                  color: _OlTheme.dim,
                  fontWeight: FontWeight.w700,
                ),
              )
            : Column(
                children: [
                  for (
                    var index = 0;
                    index < visibleHistory.length;
                    index++
                  ) ...[
                    _HistoryRow(item: visibleHistory[index]),
                    if (index != visibleHistory.length - 1)
                      const Divider(height: 18),
                  ],
                ],
              ),
      ),
      if (_historyHasMore ||
          allVisibleHistory.length > visibleHistory.length) ...[
        const SizedBox(height: 10),
        _SecondaryButton(
          label: _historyLoading
              ? 'Loading older history'
              : 'Load older history',
          onPressed: _historyLoading
              ? null
              : allVisibleHistory.length > visibleHistory.length
              ? () => setState(() => _historyVisibleCount += 10)
              : _loadOlderHistory,
        ),
      ] else if (visibleHistory.isNotEmpty) ...[
        const SizedBox(height: 10),
        const Center(
          child: Text(
            'You have reached the end of this history.',
            style: TextStyle(
              color: _OlTheme.mute,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ],
      if (_historyError != null) ...[
        const SizedBox(height: 8),
        Center(
          child: Text(
            _historyError!,
            style: const TextStyle(
              color: _OlTheme.danger,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ],
      const SizedBox(height: 16),
      _LegalLinks(
        onPrivacy: () => _openExternalPage(_privacyUrl),
        onSupport: () => _openExternalPage(_supportUrl),
        onDeleteAccount: () => _openExternalPage(_deleteAccountUrl),
      ),
    ];
  }
}

class _PluginHomeSection extends StatelessWidget {
  const _PluginHomeSection({
    required this.plugins,
    required this.availableCount,
    required this.outcomes,
    required this.onOpenPlugin,
    required this.onAddPlugins,
  });

  final List<Map> plugins;
  final int availableCount;
  final List<Map> outcomes;
  final ValueChanged<Map> onOpenPlugin;
  final VoidCallback onAddPlugins;

  @override
  Widget build(BuildContext context) {
    final categories = ['security', 'cost', 'observability', 'utility'];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Expanded(child: _SectionTitle('Safety and savings')),
            OutlinedButton.icon(
              onPressed: onAddPlugins,
              icon: const Icon(Icons.add_rounded, size: 18),
              label: Text('Add $availableCount'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        _Panel(
          child: plugins.isEmpty
              ? const Text(
                  'Leash safety checks are not available yet.',
                  style: TextStyle(
                    color: _OlTheme.dim,
                    fontWeight: FontWeight.w700,
                  ),
                )
              : Column(
                  children: [
                    for (final category in categories) ...[
                      _PluginCategoryBlock(
                        category: category,
                        plugins: plugins
                            .where(
                              (plugin) => _pluginCategory(plugin) == category,
                            )
                            .toList(),
                        outcomes: outcomes,
                        onOpenPlugin: onOpenPlugin,
                      ),
                    ],
                  ],
                ),
        ),
      ],
    );
  }
}

class _PluginCategoryBlock extends StatelessWidget {
  const _PluginCategoryBlock({
    required this.category,
    required this.plugins,
    required this.outcomes,
    required this.onOpenPlugin,
  });

  final String category;
  final List<Map> plugins;
  final List<Map> outcomes;
  final ValueChanged<Map> onOpenPlugin;

  @override
  Widget build(BuildContext context) {
    if (plugins.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _CategoryPill(category: category, count: plugins.length),
          const SizedBox(height: 8),
          ...plugins.map(
            (plugin) => Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: _PluginRow(
                plugin: plugin,
                outcomeCount: _pluginOutcomes(plugin, outcomes).length,
                onTap: () => onOpenPlugin(plugin),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PluginRow extends StatelessWidget {
  const _PluginRow({
    required this.plugin,
    required this.outcomeCount,
    required this.onTap,
  });

  final Map plugin;
  final int outcomeCount;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: _OlTheme.bg2,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: _OlTheme.line),
        ),
        child: Row(
          children: [
            _PluginIcon(plugin: plugin),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _pluginName(plugin),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontWeight: FontWeight.w900,
                      fontSize: 16,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    '$outcomeCount times checked',
                    style: const TextStyle(
                      color: _OlTheme.dim,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right_rounded, color: _OlTheme.mute),
          ],
        ),
      ),
    );
  }
}

class _PluginMarketplacePage extends StatefulWidget {
  const _PluginMarketplacePage({
    required this.plugins,
    required this.outcomes,
    required this.onInstallChanged,
    required this.onSaveSettings,
  });

  final List<Map> plugins;
  final List<Map> outcomes;
  final Future<bool> Function(Map plugin, bool installed) onInstallChanged;
  final Future<bool> Function(Map plugin, Map<String, dynamic> config)
  onSaveSettings;

  @override
  State<_PluginMarketplacePage> createState() => _PluginMarketplacePageState();
}

class _PluginMarketplacePageState extends State<_PluginMarketplacePage> {
  String _query = '';
  String _category = 'all';

  @override
  Widget build(BuildContext context) {
    final plugins = widget.plugins.where((plugin) {
      final matchesCategory =
          _category == 'all' || _pluginCategory(plugin) == _category;
      final text =
          '${_pluginName(plugin)} ${_pluginDescription(plugin)} ${_pluginCategory(plugin)}'
              .toLowerCase();
      return matchesCategory && text.contains(_query.toLowerCase());
    }).toList();
    return Scaffold(
      backgroundColor: _OlTheme.bg,
      appBar: AppBar(
        title: const Text('More from Leash'),
        backgroundColor: _OlTheme.bg,
        foregroundColor: _OlTheme.ink,
        elevation: 0,
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            TextField(
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search_rounded),
                hintText: 'Search safety and savings',
                filled: true,
                fillColor: _OlTheme.surface,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(16),
                  borderSide: const BorderSide(color: _OlTheme.line2),
                ),
              ),
              onChanged: (value) => setState(() => _query = value),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: ['all', 'security', 'cost', 'observability', 'utility']
                  .map((category) {
                    final selected = _category == category;
                    return ChoiceChip(
                      label: Text(
                        category == 'all' ? 'All' : _categoryLabel(category),
                      ),
                      selected: selected,
                      onSelected: (_) => setState(() => _category = category),
                    );
                  })
                  .toList(),
            ),
            const SizedBox(height: 16),
            if (plugins.isEmpty)
              const _Panel(
                child: Text(
                  'Nothing matches this search.',
                  style: TextStyle(
                    color: _OlTheme.dim,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              )
            else
              ...plugins.map(
                (plugin) => Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: _MarketplacePluginCard(
                    plugin: plugin,
                    onInstall: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => _PluginDetailPage(
                          plugin: plugin,
                          outcomes: _pluginOutcomes(plugin, widget.outcomes),
                          initialTab: 'settings',
                          onInstallChanged: (installed) =>
                              widget.onInstallChanged(plugin, installed),
                          onSaveSettings: (config) =>
                              widget.onSaveSettings(plugin, config),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _MarketplacePluginCard extends StatelessWidget {
  const _MarketplacePluginCard({required this.plugin, required this.onInstall});

  final Map plugin;
  final VoidCallback onInstall;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _PluginIcon(plugin: plugin),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _pluginName(plugin),
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  _pluginDescription(plugin),
                  style: const TextStyle(
                    color: _OlTheme.dim,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 10),
                _CategoryPill(category: _pluginCategory(plugin)),
              ],
            ),
          ),
          FilledButton(onPressed: onInstall, child: const Text('Enable')),
        ],
      ),
    );
  }
}

class _PluginDetailPage extends StatefulWidget {
  const _PluginDetailPage({
    required this.plugin,
    required this.outcomes,
    required this.onInstallChanged,
    required this.onSaveSettings,
    this.initialTab = 'insights',
  });

  final Map plugin;
  final List<Map> outcomes;
  final String initialTab;
  final Future<bool> Function(bool installed) onInstallChanged;
  final Future<bool> Function(Map<String, dynamic> config) onSaveSettings;

  @override
  State<_PluginDetailPage> createState() => _PluginDetailPageState();
}

class _PluginDetailPageState extends State<_PluginDetailPage> {
  late String _tab;
  late Map<String, dynamic> _config;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _tab = widget.initialTab;
    _config = _pluginConfig(widget.plugin);
  }

  @override
  Widget build(BuildContext context) {
    final installed = _pluginInstalled(widget.plugin);
    final mandatory = _pluginMandatory(widget.plugin);
    final settingsEditable = installed && !_pluginConfigLocked(widget.plugin);
    return Scaffold(
      backgroundColor: _OlTheme.bg,
      appBar: AppBar(
        title: Text(_pluginName(widget.plugin)),
        backgroundColor: _OlTheme.bg,
        foregroundColor: _OlTheme.ink,
        elevation: 0,
        actions: [
          TextButton(
            onPressed: _busy || mandatory
                ? null
                : () async {
                    final navigator = Navigator.of(context);
                    if (installed) {
                      final remove = await showDialog<bool>(
                        context: context,
                        builder: (context) => AlertDialog(
                          title: const Text('Turn this off?'),
                          content: Text(
                            'Turn off ${_pluginName(widget.plugin)} for this account?',
                          ),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(context, false),
                              child: const Text('Cancel'),
                            ),
                            FilledButton(
                              onPressed: () => Navigator.pop(context, true),
                              child: const Text('Turn off'),
                            ),
                          ],
                        ),
                      );
                      if (remove != true) return;
                    }
                    setState(() => _busy = true);
                    final ok = await widget.onInstallChanged(!installed);
                    if (!mounted) return;
                    setState(() => _busy = false);
                    if (ok) navigator.pop();
                  },
            child: Text(
              mandatory
                  ? 'Required'
                  : installed
                  ? 'Enabled'
                  : 'Enable',
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            _CategoryPill(category: _pluginCategory(widget.plugin)),
            const SizedBox(height: 10),
            Text(
              _pluginName(widget.plugin),
              style: const TextStyle(
                fontSize: 32,
                height: 1.02,
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              _pluginDescription(widget.plugin),
              style: const TextStyle(
                color: _OlTheme.dim,
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 16),
            SegmentedButton<String>(
              segments: [
                const ButtonSegment(
                  value: 'insights',
                  label: Text('At a glance'),
                ),
                ButtonSegment(
                  value: 'outcomes',
                  label: Text('History ${widget.outcomes.length}'),
                ),
                const ButtonSegment(value: 'settings', label: Text('Settings')),
              ],
              selected: {_tab},
              onSelectionChanged: (values) =>
                  setState(() => _tab = values.first),
            ),
            const SizedBox(height: 16),
            if (_tab == 'insights')
              _PluginInsightsPanel(outcomes: widget.outcomes),
            if (_tab == 'outcomes')
              _PluginOutcomesPanel(outcomes: widget.outcomes),
            if (_tab == 'settings')
              _PluginSettingsPanel(
                plugin: widget.plugin,
                config: _config,
                enabled: settingsEditable,
                busy: _busy,
                onChanged: (key, value) => setState(() => _config[key] = value),
                onSave: installed
                    ? () async {
                        setState(() => _busy = true);
                        await widget.onSaveSettings(_config);
                        if (mounted) setState(() => _busy = false);
                      }
                    : null,
              ),
          ],
        ),
      ),
    );
  }
}

class _PluginInsightsPanel extends StatelessWidget {
  const _PluginInsightsPanel({required this.outcomes});

  final List<Map> outcomes;

  @override
  Widget build(BuildContext context) {
    final blocked = outcomes
        .where(
          (item) => '${item['decision'] ?? item['status']}'
              .toLowerCase()
              .contains('block'),
        )
        .length;
    final review = outcomes
        .where((item) => '${item['status']}'.toLowerCase().contains('review'))
        .length;
    return _Panel(
      child: Row(
        children: [
          Expanded(
            child: _DashboardMetric(
              value: '${outcomes.length}',
              label: 'times checked',
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: _DashboardMetric(value: '$blocked', label: 'blocked'),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: _DashboardMetric(value: '$review', label: 'review'),
          ),
        ],
      ),
    );
  }
}

class _PluginOutcomesPanel extends StatelessWidget {
  const _PluginOutcomesPanel({required this.outcomes});

  final List<Map> outcomes;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      child: outcomes.isEmpty
          ? const Text(
              'Nothing has needed your attention yet.',
              style: TextStyle(
                color: _OlTheme.dim,
                fontWeight: FontWeight.w700,
              ),
            )
          : Column(
              children: [
                for (var index = 0; index < outcomes.length; index++) ...[
                  _HistoryRow(item: _pluginOutcomeHistoryItem(outcomes[index])),
                  if (index != outcomes.length - 1) const Divider(height: 18),
                ],
              ],
            ),
    );
  }
}

class _PluginSettingsPanel extends StatelessWidget {
  const _PluginSettingsPanel({
    required this.plugin,
    required this.config,
    required this.enabled,
    required this.busy,
    required this.onChanged,
    required this.onSave,
  });

  final Map plugin;
  final Map<String, dynamic> config;
  final bool enabled;
  final bool busy;
  final void Function(String key, dynamic value) onChanged;
  final VoidCallback? onSave;

  @override
  Widget build(BuildContext context) {
    final keys = _pluginSettingKeys(plugin, config);
    final basicKeys = keys
        .where((key) => !_isAdvancedOnlySetting(key))
        .toList();
    final advancedKeys = keys
        .where(
          (key) => _isAdvancedOnlySetting(key) || _hasAdvancedExactControl(key),
        )
        .toList();
    return _Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (basicKeys.isEmpty)
            const Text(
              'Leash handles this automatically. No setup is needed.',
              style: TextStyle(
                color: _OlTheme.dim,
                fontWeight: FontWeight.w700,
              ),
            )
          else
            ...basicKeys.map(
              (key) => Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _PluginSettingControl(
                  settingKey: key,
                  label: _settingLabel(key),
                  value: config[key],
                  enabled: enabled,
                  onChanged: (value) => onChanged(key, value),
                ),
              ),
            ),
          if (advancedKeys.isNotEmpty)
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              childrenPadding: const EdgeInsets.only(top: 8),
              title: const Text(
                'Advanced settings',
                style: TextStyle(fontWeight: FontWeight.w900),
              ),
              subtitle: const Text(
                'Exact controls for people who want to tune how Leash works.',
              ),
              children: advancedKeys
                  .map(
                    (key) => Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: _PluginSettingControl(
                        settingKey: key,
                        label: _advancedSettingLabel(key),
                        value: config[key],
                        enabled: enabled,
                        advanced: true,
                        onChanged: (value) => onChanged(key, value),
                      ),
                    ),
                  )
                  .toList(),
            ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: busy || !enabled ? null : onSave,
            child: Text(busy ? 'Saving...' : 'Save settings'),
          ),
        ],
      ),
    );
  }
}

class _PluginSettingControl extends StatelessWidget {
  const _PluginSettingControl({
    required this.settingKey,
    required this.label,
    required this.value,
    required this.enabled,
    required this.onChanged,
    this.advanced = false,
  });

  final String settingKey;
  final String label;
  final dynamic value;
  final bool enabled;
  final bool advanced;
  final ValueChanged<dynamic> onChanged;

  @override
  Widget build(BuildContext context) {
    final hint = advanced
        ? _advancedSettingHint(settingKey)
        : _pluginSettingHint(settingKey);
    final numberOptions = advanced
        ? const <Map<String, Object>>[]
        : _friendlyNumberOptions(settingKey);
    if (numberOptions.isNotEmpty) {
      final current = value is num ? value.toInt() : int.tryParse('$value');
      final selected = numberOptions.any((option) => option['value'] == current)
          ? current
          : numberOptions.first['value'] as int;
      return DropdownButtonFormField<int>(
        initialValue: selected,
        decoration: InputDecoration(
          labelText: label,
          helperText: hint.isEmpty ? null : hint,
          helperMaxLines: 3,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
        ),
        items: numberOptions
            .map(
              (option) => DropdownMenuItem<int>(
                value: option['value'] as int,
                child: Text(option['label'] as String),
              ),
            )
            .toList(),
        onChanged: enabled
            ? (next) {
                if (next != null) onChanged(next);
              }
            : null,
      );
    }
    if (settingKey == 'action' || settingKey.endsWith('Action')) {
      const options = ['allow', 'ask', 'block'];
      final selected = _normalizeProtectionAction(value);
      final index = options.indexOf(selected);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontWeight: FontWeight.w900)),
          const SizedBox(height: 3),
          const Text(
            'Let it continue records what happened. Ask me first pauses AI for your choice. Stop it blocks the action.',
            style: TextStyle(
              color: _OlTheme.dim,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
          Slider(
            value: index.toDouble(),
            min: 0,
            max: 2,
            divisions: 2,
            onChanged: enabled
                ? (next) => onChanged(options[next.round()])
                : null,
          ),
          const Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Let it continue',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800),
              ),
              Text(
                'Ask me first',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800),
              ),
              Text(
                'Stop it',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800),
              ),
            ],
          ),
        ],
      );
    }
    if (value is bool) {
      return SwitchListTile.adaptive(
        contentPadding: EdgeInsets.zero,
        title: Text(label, style: const TextStyle(fontWeight: FontWeight.w900)),
        subtitle: hint.isEmpty
            ? null
            : Text(
                hint,
                style: const TextStyle(
                  color: _OlTheme.dim,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
        value: value == true,
        onChanged: enabled ? onChanged : null,
      );
    }
    return TextFormField(
      initialValue: value?.toString() ?? '',
      enabled: enabled,
      decoration: InputDecoration(
        labelText: label,
        helperText: hint.isEmpty ? null : hint,
        helperMaxLines: 2,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
      ),
      onChanged: (next) {
        if (value is int) {
          onChanged(int.tryParse(next) ?? value);
        } else if (value is double) {
          onChanged(double.tryParse(next) ?? value);
        } else {
          onChanged(next);
        }
      },
    );
  }
}

String _pluginSettingHint(String key) {
  if (key == 'action' || key.endsWith('Action')) {
    return 'Choose whether AI continues, pauses for you, or is stopped.';
  }
  if (key == 'suspiciousRiskThreshold' || key == 'notificationRiskThreshold') {
    return 'Balanced is recommended. Choose Warn me more if you prefer extra caution.';
  }
  if (key == 'minimumCodeCharacters') {
    return 'Most code changes is recommended. Tiny snippets are less useful to check.';
  }
  if (key == 'redactSecrets') {
    return 'Private values will not appear in the history you see in Leash.';
  }
  return '';
}

String _advancedSettingLabel(String key) {
  const labels = <String, String>{
    'model': 'Evaluation model override',
    'minimumChars': 'Minimum conversation characters',
    'protectRecent': 'Recent messages kept unchanged',
    'ccrEnabled': 'Repeated-context reuse',
    'ccrTtlSeconds': 'Repeated-context reuse time (seconds)',
    'policySet': 'Evaluation policy set',
    'notificationRiskThreshold': 'Exact warning score (0–100)',
    'suspiciousRiskThreshold': 'Exact hidden-instruction score (0–100)',
    'minimumCodeCharacters': 'Exact minimum code size (characters)',
  };
  return labels[key] ?? _settingLabel(key);
}

String _advancedSettingHint(String key) {
  const hints = <String, String>{
    'model': 'Leave blank to use the model selected by Leash.',
    'minimumChars': 'Shorter conversations are left unchanged.',
    'protectRecent': 'Number of recent messages Leash always keeps as written.',
    'ccrEnabled': 'Reuse previously checked repeated text when possible.',
    'ccrTtlSeconds': 'How long reused text remains valid.',
    'policySet': 'Optional named rule set used by the evaluator.',
    'notificationRiskThreshold':
        'Lower scores create more warnings. Default: 70.',
    'suspiciousRiskThreshold':
        'Lower scores flag more hidden instructions. Default: 50.',
    'minimumCodeCharacters':
        'Code shorter than this is not checked. Default: 80.',
  };
  return hints[key] ?? '';
}

List<Map<String, Object>> _friendlyNumberOptions(String key) {
  if (key == 'notificationRiskThreshold') {
    return const [
      {'value': 45, 'label': 'Warn me more'},
      {'value': 70, 'label': 'Balanced'},
      {'value': 85, 'label': 'Only strong warnings'},
    ];
  }
  if (key == 'suspiciousRiskThreshold') {
    return const [
      {'value': 35, 'label': 'Warn me more'},
      {'value': 50, 'label': 'Balanced'},
      {'value': 70, 'label': 'Only strong warnings'},
    ];
  }
  if (key == 'minimumCodeCharacters') {
    return const [
      {'value': 40, 'label': 'Every code change'},
      {'value': 80, 'label': 'Most code changes'},
      {'value': 250, 'label': 'Only larger changes'},
    ];
  }
  return const [];
}

class _PluginIcon extends StatelessWidget {
  const _PluginIcon({required this.plugin});

  final Map plugin;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 42,
      height: 42,
      decoration: BoxDecoration(
        color: _OlTheme.accentSoft,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Center(
        child: Text(
          _pluginInitials(plugin),
          style: const TextStyle(
            color: _OlTheme.accent,
            fontWeight: FontWeight.w900,
          ),
        ),
      ),
    );
  }
}

class _CategoryPill extends StatelessWidget {
  const _CategoryPill({required this.category, this.count});

  final String category;
  final int? count;

  @override
  Widget build(BuildContext context) {
    return Chip(
      label: Text(
        '${_categoryLabel(category)}${count == null ? '' : ' $count'}',
      ),
      avatar: Icon(_categoryIcon(category), size: 16),
      backgroundColor: _categoryColor(category),
      side: BorderSide.none,
    );
  }
}

bool _pluginInstalled(Map plugin) {
  final policy = plugin['organizationPolicy'];
  final settings = plugin['settings'];
  return (policy is Map && policy['mandatory'] == true) ||
      (settings is Map && settings['enabled'] == true) ||
      plugin['installed'] == true;
}

bool _pluginMandatory(Map plugin) {
  final policy = plugin['organizationPolicy'];
  return policy is Map && policy['mandatory'] == true;
}

bool _pluginConfigLocked(Map plugin) {
  final policy = plugin['organizationPolicy'];
  return _pluginMandatory(plugin) ||
      (policy is Map && policy['configLocked'] == true);
}

int _comparePlugins(Map left, Map right) {
  const order = {'security': 0, 'cost': 1, 'observability': 2, 'utility': 3};
  final categoryOrder = (order[_pluginCategory(left)] ?? 9).compareTo(
    order[_pluginCategory(right)] ?? 9,
  );
  if (categoryOrder != 0) return categoryOrder;
  return _pluginName(
    left,
  ).toLowerCase().compareTo(_pluginName(right).toLowerCase());
}

String _pluginName(Map plugin) {
  final compatibilityName = _pluginCompatibilityName(plugin);
  final canonicalName = leashFeaturePresentations[compatibilityName]?['name'];
  if (canonicalName != null) return canonicalName;
  final supplied =
      plugin['displayName']?.toString() ?? plugin['name']?.toString();
  if (supplied != null &&
      supplied.trim().isNotEmpty &&
      !supplied.contains('-')) {
    return supplied.trim();
  }
  return _readableFeatureName(compatibilityName);
}

String _pluginCompatibilityName(Map plugin) {
  final marketplace = plugin['marketplace'];
  final raw =
      plugin['slug']?.toString() ??
      (marketplace is Map ? marketplace['slug']?.toString() : null) ??
      plugin['packageId']?.toString() ??
      plugin['id']?.toString().split('.').last ??
      plugin['name']?.toString() ??
      'feature';
  final normalized = raw
      .replaceFirst(RegExp(r'^openleash[._-]'), '')
      .trim()
      .toLowerCase();
  const aliases = {
    'blast radius': 'blast-radius',
    'prompt-compression': 'token-saver',
    'prompt compression': 'token-saver',
    'token-compression': 'token-saver',
    'token compression': 'token-saver',
    'token saver': 'token-saver',
    'dlp': 'data-leakage-prevention',
  };
  return aliases[normalized] ?? normalized.replaceAll(RegExp(r'[\s_]+'), '-');
}

String _readableFeatureName(String value) {
  return value
      .split(RegExp(r'[-_\s]+'))
      .where((part) => part.isNotEmpty)
      .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
      .join(' ');
}

String _pluginDescription(Map plugin) {
  final canonicalDescription =
      leashFeaturePresentations[_pluginCompatibilityName(
        plugin,
      )]?['description'];
  if (canonicalDescription != null) return canonicalDescription;
  final marketplace = plugin['marketplace'];
  return (marketplace is Map
          ? marketplace['shortDescription']?.toString()
          : null) ??
      plugin['description']?.toString() ??
      'Leash Feature';
}

String _pluginInitials(Map plugin) {
  final parts = _pluginName(
    plugin,
  ).split(RegExp(r'[^a-zA-Z0-9]+')).where((part) => part.isNotEmpty).toList();
  if (parts.length > 1) {
    return parts.take(2).map((part) => part[0]).join().toUpperCase();
  }
  return _pluginName(plugin).padRight(2).substring(0, 2).toUpperCase();
}

String _pluginCategory(Map plugin) {
  final compatibilityName = _pluginCompatibilityName(plugin);
  if (compatibilityName == 'token-saver') return 'cost';
  if ({
    'blast-radius',
    'code-scanner',
    'data-leakage-prevention',
    'mcp-scanner',
    'rules-enforcer',
    'sensitive-access',
    'skill-scanner',
  }.contains(compatibilityName)) {
    return 'security';
  }
  final marketplace = plugin['marketplace'];
  final marketplaceTags = marketplace is Map && marketplace['tags'] is List
      ? (marketplace['tags'] as List).join(' ')
      : '';
  final pluginTags = plugin['tags'] is List
      ? (plugin['tags'] as List).join(' ')
      : '';
  final explicit = [
    marketplace is Map ? marketplace['category'] : null,
    plugin['category'],
    plugin['manifest'] is Map ? (plugin['manifest'] as Map)['category'] : null,
  ].whereType<Object>().map((item) => item.toString().toLowerCase()).join(' ');
  final text = explicit.isNotEmpty
      ? explicit
      : '${plugin['id'] ?? ''} ${plugin['name'] ?? ''} ${plugin['description'] ?? ''} $marketplaceTags $pluginTags'
            .toLowerCase();
  if (RegExp(r'mcp-scanner|skill-scanner').hasMatch(text)) {
    return 'security';
  }
  if (RegExp(
    r'security|policy|guard|skill|risk|approval|dlp|leak|secret|credential',
  ).hasMatch(text)) {
    return 'security';
  }
  if (RegExp(
    r'visibility|observability|observe|log|mcp|siem|audit|telemetry|monitor',
  ).hasMatch(text)) {
    return 'observability';
  }
  if (RegExp(r'cost|token|compression|usage|budget|spend').hasMatch(text)) {
    return 'cost';
  }
  return 'utility';
}

String _categoryLabel(String category) {
  if (category == 'security') return 'Safety';
  if (category == 'cost') return 'Save money';
  if (category == 'observability') return 'Visibility';
  if (category == 'utility') return 'Other';
  return 'All';
}

IconData _categoryIcon(String category) {
  if (category == 'security') return Icons.shield_outlined;
  if (category == 'observability') return Icons.visibility_outlined;
  if (category == 'utility') return Icons.bolt_outlined;
  if (category == 'all') return Icons.apps_rounded;
  return Icons.trending_down_rounded;
}

Color _categoryColor(String category) {
  if (category == 'security') return const Color(0xff0e251d);
  if (category == 'observability') return const Color(0xff101c2b);
  if (category == 'utility') return const Color(0xff251b0e);
  return _OlTheme.accentSoft;
}

List<Map> _pluginOutcomes(Map plugin, List<Map> outcomes) {
  final id = plugin['id']?.toString();
  return outcomes.where((outcome) {
    final source = outcome['source'];
    return source is Map && source['pluginId']?.toString() == id;
  }).toList();
}

Map<String, dynamic> _pluginConfig(Map plugin) {
  final settings = plugin['settings'];
  final defaultConfig = plugin['defaultConfig'];
  return {
    if (defaultConfig is Map) ...defaultConfig.cast<String, dynamic>(),
    if (settings is Map && settings['config'] is Map)
      ...(settings['config'] as Map).cast<String, dynamic>(),
  };
}

List<String> _pluginSettingKeys(Map plugin, Map<String, dynamic> config) {
  final keys = <String>{...config.keys};
  final schema = plugin['configSchema'];
  final properties = schema is Map ? schema['properties'] : null;
  if (properties is Map) {
    keys.addAll(properties.keys.map((key) => key.toString()));
  }
  keys.remove('enabled');
  return keys.toList()..sort();
}

const _advancedOnlySettingKeys = {
  'model',
  'minimumChars',
  'protectRecent',
  'ccrEnabled',
  'ccrTtlSeconds',
  'policySet',
};

const _advancedExactSettingKeys = {
  'notificationRiskThreshold',
  'suspiciousRiskThreshold',
  'minimumCodeCharacters',
};

bool _isAdvancedOnlySetting(String key) =>
    _advancedOnlySettingKeys.contains(key);

bool _hasAdvancedExactControl(String key) =>
    _advancedExactSettingKeys.contains(key);

String _settingLabel(String value) {
  const labels = <String, String>{
    'action': 'If AI tries to share private information',
    'categories': 'What should Leash keep private?',
    'destructiveAction': 'Deleting or destroying things',
    'databaseMutationAction': 'Changing your database',
    'broadFilesystemAction': 'Changing lots of files at once',
    'secretFileAction': 'Opening password or sign-in files',
    'envDumpAction': 'Showing saved passwords or access keys',
    'exfiltrationAction': 'Sending private information somewhere else',
    'suspiciousRiskThreshold': 'How cautious should Leash be?',
    'notificationRiskThreshold': 'When should Leash warn you?',
    'minimumCodeCharacters': 'Which code changes should Leash check?',
    'redactSecrets': 'Hide private values in Leash history',
    'rules': 'Your rules',
    'level': 'How much should Leash save?',
    'conciseResponse': 'Ask AI for shorter answers',
    'pii': 'Personal information',
    'phi': 'Health information',
    'tokens': 'Sign-in codes',
    'keys': 'Computer access keys',
    'credentials': 'Passwords and sign-in details',
    'allow': 'Let it continue',
    'ask': 'Ask me first',
    'block': 'Stop it',
    'light': 'Save a little',
    'standard': 'Balanced',
    'maximum': 'Save the most',
  };
  if (labels.containsKey(value)) return labels[value]!;
  final spaced = value
      .replaceAll(RegExp(r'[_-]+'), ' ')
      .replaceAllMapped(
        RegExp(r'([a-z0-9])([A-Z])'),
        (match) => '${match[1]} ${match[2]}',
      )
      .trim();
  return spaced
      .split(' ')
      .where((part) => part.isNotEmpty)
      .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
      .join(' ');
}

String _normalizeProtectionAction(dynamic value) {
  if (value?.toString() == 'allow') return 'allow';
  if (value?.toString() == 'block') return 'block';
  return 'ask';
}

Map<String, dynamic> _pluginOutcomeHistoryItem(Map outcome) {
  final agent = outcome['agent'] is Map ? outcome['agent'] as Map : const {};
  final context = outcome['context'] is Map
      ? outcome['context'] as Map
      : const {};
  final subject = outcome['subject'] is Map
      ? outcome['subject'] as Map
      : const {};
  final decision = '${outcome['decision'] ?? outcome['status'] ?? 'allow'}'
      .toLowerCase();
  final resolution = RegExp(r'block|stop|deny').hasMatch(decision)
      ? 'deny'
      : RegExp(r'ask|question|review|waiting|pending').hasMatch(decision)
      ? 'ask'
      : 'allow';
  final evidence = ((outcome['evidence'] as List?) ?? const [])
      .whereType<Map>()
      .toList();
  return {
    'id': outcome['id'],
    'summary': outcome['title'] ?? 'Leash checked an agent action',
    'question':
        outcome['summary'] ??
        'Leash recorded this agent action so you can understand what happened.',
    'resolution': resolution,
    'decision': resolution,
    'agent_name': agent['name'] ?? agent['kind'] ?? 'AI agent',
    'hostname': agent['hostname'] ?? 'This device',
    'project_path': context['projectPath'] ?? subject['name'] ?? '',
    'tool_name': context['toolName'] ?? '',
    'event_name': context['eventName'] ?? '',
    'created_at': outcome['occurredAt'] ?? outcome['createdAt'],
    'triggered_policies': evidence
        .map(
          (item) => {
            'policy_name': item['label'] ?? 'What Leash noticed',
            'explanation': item['value'] ?? 'Recorded',
            'evidence': [item['value'] ?? 'Recorded'],
          },
        )
        .toList(),
    'payload': {
      if (outcome['details'] is Map) ...(outcome['details'] as Map),
      'source': outcome['source'],
      'subject': outcome['subject'],
      'evidence': evidence,
    },
  };
}

class ApprovalNotifications {
  final _plugin = FlutterLocalNotificationsPlugin();
  bool soundsEnabled = true;
  Future<void> Function(
    String id,
    String resolution,
    String? resolutionGuidance,
  )?
  onDecision;

  Future<void> init() async {
    const android = AndroidInitializationSettings('@mipmap/ic_launcher');
    final darwin = DarwinInitializationSettings(
      defaultPresentAlert: true,
      defaultPresentBadge: true,
      defaultPresentSound: true,
      notificationCategories: [
        DarwinNotificationCategory(
          'openleash_approval',
          actions: [
            DarwinNotificationAction.plain(
              'deny',
              'Deny',
              options: <DarwinNotificationActionOption>{
                DarwinNotificationActionOption.destructive,
              },
            ),
            DarwinNotificationAction.plain('allow', 'Allow'),
          ],
        ),
        DarwinNotificationCategory(
          'openleash_approval_guidance',
          actions: [
            DarwinNotificationAction.plain(
              'deny',
              'Deny',
              options: <DarwinNotificationActionOption>{
                DarwinNotificationActionOption.destructive,
              },
            ),
            DarwinNotificationAction.text(
              'deny_with_guidance',
              'Guide',
              buttonTitle: 'Deny',
              placeholder: 'Tell the agent what to do instead',
              options: <DarwinNotificationActionOption>{
                DarwinNotificationActionOption.destructive,
              },
            ),
            DarwinNotificationAction.plain('allow', 'Allow'),
          ],
        ),
      ],
    );
    await _plugin.initialize(
      settings: InitializationSettings(android: android, iOS: darwin),
      onDidReceiveNotificationResponse: (response) {
        final payload = response.payload;
        final action = response.actionId;
        if (payload != null && (action == 'allow' || action == 'deny')) {
          onDecision?.call(payload, action!, null);
        }
        if (payload != null && action == 'deny_with_guidance') {
          onDecision?.call(payload, 'deny', response.input);
        }
      },
    );
  }

  Future<void> requestPermissions() async {
    await _plugin
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >()
        ?.requestPermissions(alert: true, badge: true, sound: true);
    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.requestNotificationsPermission();
  }

  Future<void> showApproval(Approval approval) async {
    final supportsGuidance = _supportsAgentGuidance(approval.agentKind);
    final android = AndroidNotificationDetails(
      'openleash_approvals_question_v1',
      'Leash approvals',
      channelDescription: 'Approve or deny Leash agent actions.',
      importance: Importance.high,
      priority: Priority.high,
      visibility: NotificationVisibility.public,
      category: AndroidNotificationCategory.status,
      playSound: soundsEnabled,
      sound: soundsEnabled
          ? const RawResourceAndroidNotificationSound('question')
          : null,
      actions: [
        const AndroidNotificationAction('deny', 'Deny'),
        if (supportsGuidance)
          const AndroidNotificationAction(
            'deny_with_guidance',
            'Guide',
            inputs: <AndroidNotificationActionInput>[
              AndroidNotificationActionInput(
                label: 'Tell the agent what to do instead',
              ),
            ],
          ),
        const AndroidNotificationAction('allow', 'Allow'),
      ],
    );
    final darwin = DarwinNotificationDetails(
      categoryIdentifier: supportsGuidance
          ? 'openleash_approval_guidance'
          : 'openleash_approval',
      presentAlert: true,
      presentBadge: true,
      presentSound: soundsEnabled,
      sound: soundsEnabled ? 'question.mp3' : null,
      presentBanner: true,
      presentList: true,
      interruptionLevel: InterruptionLevel.timeSensitive,
    );
    await _plugin.show(
      id: approval.id.hashCode & 0x7fffffff,
      title: 'Allow ${approval.agent}?',
      body: approval.notificationBody,
      notificationDetails: NotificationDetails(android: android, iOS: darwin),
      payload: approval.id,
    );
  }

  Future<void> showAttention(Map event, Approval? approval) async {
    final kind = event['kind']?.toString() ?? 'approval';
    if (kind == 'approval' && approval != null) {
      await showApproval(approval);
      return;
    }
    final title = switch (kind) {
      'question' => 'An agent has a question',
      'plan_review' => 'An agent plan is ready',
      'blocked' => 'Leash blocked an action',
      'subagent_completed' => 'A subagent finished',
      'completed' => 'An agent finished',
      _ => event['title']?.toString() ?? 'Leash update',
    };
    final body =
        event['body']?.toString() ??
        event['title']?.toString() ??
        (kind == 'question' || kind == 'plan_review'
            ? 'Open Leash to respond.'
            : 'Open Leash to view the details.');
    final actionable =
        event['state'] == 'waiting' &&
        (kind == 'question' || kind == 'plan_review');
    final android = AndroidNotificationDetails(
      actionable ? 'openleash_attention_question_v1' : 'openleash_updates',
      actionable ? 'Leash attention' : 'Leash updates',
      channelDescription: actionable
          ? 'Questions and plans that need your response.'
          : 'Agent completion and policy updates.',
      importance: actionable ? Importance.high : Importance.defaultImportance,
      priority: actionable ? Priority.high : Priority.defaultPriority,
      visibility: NotificationVisibility.public,
      category: actionable
          ? AndroidNotificationCategory.status
          : AndroidNotificationCategory.progress,
      playSound: actionable && soundsEnabled,
      sound: actionable && soundsEnabled
          ? const RawResourceAndroidNotificationSound('question')
          : null,
    );
    final darwin = DarwinNotificationDetails(
      presentAlert: true,
      presentBadge: actionable,
      presentSound: actionable && soundsEnabled,
      sound: actionable && soundsEnabled ? 'question.mp3' : null,
      presentBanner: true,
      presentList: true,
      interruptionLevel: actionable
          ? InterruptionLevel.timeSensitive
          : InterruptionLevel.active,
    );
    await _plugin.show(
      id: (event['id']?.toString() ?? title).hashCode & 0x7fffffff,
      title: title,
      body: body,
      notificationDetails: NotificationDetails(android: android, iOS: darwin),
      payload: event['decisionId']?.toString(),
    );
  }
}

class Approval {
  Approval({
    required this.id,
    this.kind = 'approval',
    this.interaction,
    required this.title,
    required this.agent,
    this.agentKind,
    required this.project,
    required this.policy,
    required this.plugin,
    this.purpose,
    this.quote,
    this.context = const [],
    required this.createdAt,
  });

  final String id;
  final String kind;
  final Map<String, dynamic>? interaction;
  final String title;
  final String agent;
  final String? agentKind;
  final String project;
  final String policy;
  final String plugin;
  final String? purpose;
  final String? quote;
  final List<ApprovalContextLine> context;
  final DateTime createdAt;

  bool get isQuestion =>
      kind == 'question' || interaction?['type'] == 'questions';
  bool get isPlan => kind == 'plan_review' || interaction?['type'] == 'plan';
  Map<String, dynamic> get originalInput {
    final value = interaction?['originalInput'];
    return value is Map ? Map<String, dynamic>.from(value) : {};
  }

  String get notificationBody {
    final lines = [
      title,
      if (purpose != null && purpose!.trim().isNotEmpty)
        'Why: ${purpose!.trim()}',
      'Project: $project',
      'Rule: $policy',
      'Feature: $plugin',
      if (quote != null && quote!.trim().isNotEmpty) 'Quote: ${quote!.trim()}',
      if (context.isNotEmpty) 'Context: ${context.last.content}',
    ];
    return lines.join('\n');
  }
}

String? _cleanResolutionGuidance(String? value) {
  final cleaned = (value ?? '').replaceAll(RegExp(r'\s+'), ' ').trim();
  if (cleaned.isEmpty) return null;
  return cleaned.length > 500 ? cleaned.substring(0, 500) : cleaned;
}

bool _supportsAgentGuidance(String? agentKind) {
  return const {
    'claude-code',
    'codex',
    'openclaw',
    'nanoclaw',
  }.contains(agentKind);
}

class _CloudTrialCard extends StatelessWidget {
  const _CloudTrialCard({required this.billing});

  final Map<String, dynamic> billing;

  @override
  Widget build(BuildContext context) {
    final trial = billing['trial'] as Map;
    final expired = billing['upgradeRequired'] == true;
    final days = trial['daysRemaining'] ?? 0;
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: expired ? const Color(0xffffeeee) : const Color(0xfff1efff),
        border: Border.all(
          color: expired ? const Color(0xffef9aa5) : const Color(0xffc8bcff),
        ),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(
            expired ? Icons.warning_amber_rounded : Icons.cloud_done_outlined,
            color: expired ? const Color(0xffa21f2e) : _OlTheme.accent,
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  expired
                      ? 'Your Leash Cloud trial ended'
                      : '$days days left in your Cloud trial',
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
                Text(
                  expired
                      ? 'Upgrade to keep Leash AI protection active.'
                      : 'Leash AI is included during your trial.',
                  style: const TextStyle(color: _OlTheme.dim),
                ),
              ],
            ),
          ),
          if (expired)
            TextButton(
              onPressed: () => launchUrl(
                Uri.parse('https://openleash.com/account'),
                mode: LaunchMode.externalApplication,
              ),
              child: const Text('Upgrade'),
            ),
        ],
      ),
    );
  }
}

class ApprovalContextLine {
  const ApprovalContextLine({required this.role, required this.content});

  final String role;
  final String content;
}

class _LogoHeader extends StatelessWidget {
  const _LogoHeader({
    required this.signedIn,
    required this.trialLabel,
    required this.notificationSounds,
    required this.onNotificationSoundsChanged,
    required this.onSignOut,
    required this.onPrivacy,
    required this.onSupport,
    required this.onDeleteAccount,
  });

  final bool signedIn;
  final String? trialLabel;
  final bool notificationSounds;
  final ValueChanged<bool> onNotificationSoundsChanged;
  final VoidCallback onSignOut;
  final VoidCallback onPrivacy;
  final VoidCallback onSupport;
  final VoidCallback onDeleteAccount;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Image.asset(
            'assets/openleash-icon.png',
            width: 34,
            height: 34,
            fit: BoxFit.contain,
          ),
        ),
        const SizedBox(width: 12),
        const Text(
          'Leash',
          style: TextStyle(
            fontSize: 20,
            letterSpacing: -0.4,
            fontWeight: FontWeight.w800,
          ),
        ),
        const Spacer(),
        if (signedIn)
          PopupMenuButton<String>(
            tooltip: 'Settings',
            icon: const Icon(Icons.more_horiz_rounded, size: 25),
            color: _OlTheme.surfaceRaised,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
            onSelected: (value) {
              if (value == 'notification-sounds') {
                onNotificationSoundsChanged(!notificationSounds);
              }
              if (value == 'sign-out') onSignOut();
              if (value == 'privacy') onPrivacy();
              if (value == 'support') onSupport();
              if (value == 'delete-account') onDeleteAccount();
            },
            itemBuilder: (context) => [
              if (trialLabel != null)
                PopupMenuItem(
                  enabled: false,
                  child: Row(
                    children: [
                      const Icon(Icons.cloud_outlined, size: 20),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          trialLabel!,
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ),
                    ],
                  ),
                ),
              PopupMenuItem(
                value: 'notification-sounds',
                child: Row(
                  children: [
                    Icon(
                      notificationSounds
                          ? Icons.volume_up_outlined
                          : Icons.volume_off_outlined,
                      size: 20,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        notificationSounds
                            ? 'Notification sounds on'
                            : 'Notification sounds off',
                      ),
                    ),
                    Switch.adaptive(
                      value: notificationSounds,
                      onChanged: onNotificationSoundsChanged,
                    ),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: 'privacy',
                child: Row(
                  children: [
                    Icon(Icons.privacy_tip_outlined, size: 20),
                    SizedBox(width: 10),
                    Text('Privacy Policy'),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: 'support',
                child: Row(
                  children: [
                    Icon(Icons.support_agent_rounded, size: 20),
                    SizedBox(width: 10),
                    Text('Support'),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: 'delete-account',
                child: Row(
                  children: [
                    Icon(Icons.delete_outline_rounded, size: 20),
                    SizedBox(width: 10),
                    Text('Delete account'),
                  ],
                ),
              ),
              const PopupMenuItem(
                value: 'sign-out',
                child: Row(
                  children: [
                    Icon(Icons.logout_rounded, size: 20),
                    SizedBox(width: 10),
                    Text('Sign out'),
                  ],
                ),
              ),
            ],
          ),
      ],
    );
  }
}

class _LegalLinks extends StatelessWidget {
  const _LegalLinks({
    required this.onPrivacy,
    required this.onSupport,
    required this.onDeleteAccount,
  });

  final VoidCallback onPrivacy;
  final VoidCallback onSupport;
  final VoidCallback onDeleteAccount;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      alignment: WrapAlignment.center,
      spacing: 6,
      runSpacing: 6,
      children: [
        _TextLink(label: 'Privacy Policy', onPressed: onPrivacy),
        _TextLink(label: 'Support', onPressed: onSupport),
        _TextLink(label: 'Delete account', onPressed: onDeleteAccount),
      ],
    );
  }
}

class _TextLink extends StatelessWidget {
  const _TextLink({required this.label, required this.onPressed});

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      style: TextButton.styleFrom(
        foregroundColor: _OlTheme.dim,
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
        textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
      ),
      onPressed: onPressed,
      child: Text(label),
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _OlTheme.surface.withValues(alpha: 0.96),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: _OlTheme.line),
        boxShadow: _OlTheme.panelShadow,
      ),
      child: child,
    );
  }
}

class _Input extends StatelessWidget {
  const _Input({
    required this.controller,
    required this.label,
    required this.hint,
  });

  final TextEditingController controller;
  final String label;
  final String hint;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        filled: true,
        fillColor: _OlTheme.bg2,
        labelStyle: const TextStyle(color: _OlTheme.dim),
        hintStyle: const TextStyle(color: _OlTheme.mute),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: _OlTheme.line2),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: _OlTheme.line2),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: _OlTheme.accent, width: 1.4),
        ),
      ),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({
    required this.label,
    required this.icon,
    required this.onPressed,
  });

  final String label;
  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      style: FilledButton.styleFrom(
        backgroundColor: _OlTheme.accent,
        foregroundColor: _OlTheme.bg,
        padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 20),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      onPressed: onPressed,
      icon: Icon(icon),
      label: Text(
        label,
        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w900),
      ),
    );
  }
}

class _GoogleButton extends StatelessWidget {
  const _GoogleButton({required this.onPressed, required this.busy});

  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton(
        style: OutlinedButton.styleFrom(
          backgroundColor: _OlTheme.surfaceRaised,
          foregroundColor: _OlTheme.ink,
          padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 20),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          side: const BorderSide(color: _OlTheme.line2),
        ),
        onPressed: busy ? null : onPressed,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              height: 30,
              width: 30,
              decoration: BoxDecoration(
                color: _OlTheme.surface,
                borderRadius: BorderRadius.circular(4),
                border: Border.all(color: _OlTheme.line2),
              ),
              child: const Center(
                child: Text(
                  'G',
                  style: TextStyle(
                    color: Color(0xff4285f4),
                    fontSize: 19,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Text(
              busy ? 'Opening Google...' : 'Sign in with Google',
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProviderButton extends StatelessWidget {
  const _ProviderButton({
    required this.label,
    required this.mark,
    required this.onPressed,
    required this.busy,
  });

  final String label;
  final String mark;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton(
        style: OutlinedButton.styleFrom(
          backgroundColor: _OlTheme.surface,
          foregroundColor: _OlTheme.ink,
          padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 20),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          side: const BorderSide(color: _OlTheme.line2),
        ),
        onPressed: busy ? null : onPressed,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              mark,
              style: const TextStyle(
                color: _OlTheme.accent,
                fontSize: 19,
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(width: 12),
            Text(
              busy ? 'Opening...' : label,
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
    );
  }
}

class _SecondaryButton extends StatelessWidget {
  const _SecondaryButton({required this.label, required this.onPressed});

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      style: OutlinedButton.styleFrom(
        padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 20),
        backgroundColor: _OlTheme.surface,
        foregroundColor: _OlTheme.ink,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        side: const BorderSide(color: _OlTheme.line2),
      ),
      onPressed: onPressed,
      child: Text(
        label,
        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w900),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _OlTheme.dangerSoft,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _OlTheme.danger.withValues(alpha: 0.18)),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: _OlTheme.danger),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w900),
    );
  }
}

class _ActiveSessionHeader extends StatelessWidget {
  const _ActiveSessionHeader({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Text(
            'ACTIVE AGENT SESSIONS ($count)',
            style: const TextStyle(
              color: _OlTheme.accent,
              fontSize: 13,
              letterSpacing: 2.2,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
        const Text(
          'Realtime Remote Nodes',
          style: TextStyle(
            color: _OlTheme.dim,
            fontSize: 12,
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    );
  }
}

class _DashboardMetric extends StatelessWidget {
  const _DashboardMetric({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        color: _OlTheme.bg2,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _OlTheme.line),
      ),
      child: Column(
        children: [
          Text(
            value,
            style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w900),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: const TextStyle(
              color: _OlTheme.dim,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyApprovals extends StatelessWidget {
  const _EmptyApprovals();

  @override
  Widget build(BuildContext context) {
    return const _Panel(
      child: Column(
        children: [
          Icon(Icons.computer_rounded, size: 48, color: _OlTheme.accent),
          SizedBox(height: 12),
          Text(
            'No agents connected yet',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900),
          ),
          SizedBox(height: 6),
          Text(
            'Install Leash Client on your Mac or Windows computer. Your agents and approvals will appear here.',
            textAlign: TextAlign.center,
            style: TextStyle(color: _OlTheme.dim, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

class _AgentCard extends StatefulWidget {
  const _AgentCard({required this.agent, required this.onMonitoringChanged});

  final Map agent;
  final ValueChanged<bool> onMonitoringChanged;

  @override
  State<_AgentCard> createState() => _AgentCardState();
}

class _AgentCardState extends State<_AgentCard> {
  @override
  Widget build(BuildContext context) {
    final agent = widget.agent;
    final name = _agentName(agent);
    final kind = _agentKindLabel(agent);
    final status = _agentStatus(agent);
    final summary = _agentSummary(agent);
    final sessions = _agentSessions(agent);
    final primarySession = sessions.isNotEmpty ? sessions.first : null;
    final target = primarySession?['title']?.toString() ?? summary;
    final stream = _sessionStream(primarySession, agent);
    final elapsed = primarySession == null
        ? _relativeTime(_agentActivityAt(agent))
        : _formatDuration(
            primarySession['duration_seconds'] ??
                primarySession['durationSeconds'],
          );
    final syncId = _shortSyncId(primarySession?['session_id'] ?? agent['id']);
    final completedCalls =
        primarySession?['event_count'] ?? primarySession?['eventCount'] ?? 0;
    final nodeCount = _agentNodeCount(agent);
    final tint = _agentTint(status);
    final installed = agent['installed'] != false;
    final monitored =
        agent['desired_monitored'] == true || agent['desiredMonitored'] == true;
    return InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: primarySession == null
          ? null
          : () => _openSessionDetail(context, primarySession, name),
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: tint.card,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: tint.border),
          boxShadow: _OlTheme.panelShadow,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: tint.surface,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: tint.border),
                  ),
                  clipBehavior: Clip.antiAlias,
                  child: Padding(
                    padding: const EdgeInsets.all(6),
                    child: Image.asset(
                      _agentIconAsset(agent),
                      fit: BoxFit.contain,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w900,
                          height: 1.05,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              kind.toUpperCase(),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: _OlTheme.accent,
                                fontSize: 11,
                                letterSpacing: 1.9,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                          const Padding(
                            padding: EdgeInsets.symmetric(horizontal: 7),
                            child: Text('•', style: TextStyle(fontSize: 14)),
                          ),
                          Text(
                            'Node : $nodeCount',
                            style: const TextStyle(
                              color: _OlTheme.dim,
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Switch.adaptive(
                  value: monitored,
                  onChanged: installed ? widget.onMonitoringChanged : null,
                  activeThumbColor: _OlTheme.ok,
                ),
                const SizedBox(width: 8),
                _AgentStatusPill(status: status),
              ],
            ),
            const SizedBox(height: 22),
            const Divider(height: 1, color: _OlTheme.line),
            const SizedBox(height: 18),
            const Text(
              'TARGET GOAL & PURPOSE',
              style: TextStyle(
                color: _OlTheme.dim,
                fontSize: 11,
                letterSpacing: 1.8,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              target,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: _OlTheme.ink,
                fontSize: 23,
                height: 1.18,
                letterSpacing: -0.45,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 16),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: _OlTheme.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: _OlTheme.line),
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x0d0c0c0a),
                    blurRadius: 18,
                    offset: Offset(0, 8),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'ACTIVE REMOTE WORKTIME STREAM',
                    style: TextStyle(
                      color: _OlTheme.dim,
                      fontSize: 10,
                      letterSpacing: 1.6,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        width: 7,
                        height: 7,
                        margin: const EdgeInsets.only(top: 7),
                        decoration: BoxDecoration(
                          color: tint.dot,
                          borderRadius: BorderRadius.circular(99),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          '“$stream”',
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: tint.text,
                            fontSize: 16,
                            height: 1.25,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: _TinyMeta(label: 'ELAPSED', value: elapsed),
                      ),
                      _TinyMeta(label: 'SYNC ID', value: syncId),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            const Divider(height: 1, color: _OlTheme.line),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: Text.rich(
                    TextSpan(
                      text: 'Completed calls: ',
                      style: const TextStyle(
                        color: _OlTheme.dim,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                      children: [
                        TextSpan(
                          text: '$completedCalls',
                          style: const TextStyle(
                            color: _OlTheme.ink,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: primarySession == null
                      ? null
                      : () => _openSessionDetail(context, primarySession, name),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: _OlTheme.dim,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 9,
                    ),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(999),
                    ),
                    side: const BorderSide(color: _OlTheme.line2),
                    textStyle: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  icon: const Icon(Icons.shield_outlined, size: 15),
                  label: const Text('LEASH CODE'),
                ),
                const SizedBox(width: 8),
                IconButton.outlined(
                  onPressed: primarySession == null
                      ? null
                      : () => _openSessionDetail(context, primarySession, name),
                  style: IconButton.styleFrom(
                    foregroundColor: _OlTheme.ink,
                    side: const BorderSide(color: _OlTheme.line2),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(999),
                    ),
                  ),
                  icon: const Icon(Icons.north_east, size: 17),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _AgentStatusPill extends StatelessWidget {
  const _AgentStatusPill({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final tint = _agentTint(status);
    return Container(
      constraints: const BoxConstraints(minWidth: 86),
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
      decoration: BoxDecoration(
        color: tint.surface,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: tint.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: tint.dot,
              borderRadius: BorderRadius.circular(99),
            ),
          ),
          const SizedBox(width: 7),
          Flexible(
            child: Text(
              _statusCopy(status).toUpperCase(),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: tint.text,
                fontSize: 10,
                height: 1.05,
                letterSpacing: 1.2,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TinyMeta extends StatelessWidget {
  const _TinyMeta({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(
        text: '$label: ',
        style: const TextStyle(
          color: _OlTheme.dim,
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
        children: [
          TextSpan(
            text: value,
            style: const TextStyle(
              color: _OlTheme.ink2,
              fontWeight: FontWeight.w900,
            ),
          ),
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
  }
}

class _AgentActionRow extends StatelessWidget {
  const _AgentActionRow({required this.item});

  final Map item;

  @override
  Widget build(BuildContext context) {
    final decision =
        item['resolution']?.toString() ??
        item['decision']?.toString() ??
        'logged';
    final summary = _eventSummary(item);
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => _openEventDetail(context, item),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              _decisionIcon(decision),
              size: 18,
              color: _decisionColor(decision),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    summary,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: _OlTheme.ink2,
                      height: 1.25,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${_friendlyAction(item)} · ${_relativeTime(item['created_at'] ?? item['createdAt'] ?? item['activity_at'] ?? item['activityAt'])}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: _OlTheme.dim,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: _OlTheme.mute),
          ],
        ),
      ),
    );
  }
}

void _openSessionDetail(BuildContext context, Map session, String agentName) {
  Navigator.of(context).push(
    MaterialPageRoute(
      builder: (_) =>
          _SessionDetailPage(session: session, agentName: agentName),
    ),
  );
}

class _SessionDetailPage extends StatelessWidget {
  const _SessionDetailPage({required this.session, required this.agentName});

  final Map session;
  final String agentName;

  @override
  Widget build(BuildContext context) {
    final events = ((session['events'] as List?) ?? const [])
        .whereType<Map>()
        .toList();
    final mcpServers =
        ((session['mcp_servers'] as List?) ??
                (session['mcpServers'] as List?) ??
                const [])
            .map((item) => item.toString())
            .where((item) => item.trim().isNotEmpty)
            .toList();
    final project =
        _projectNameFromAny(
          session['project_path'] ?? session['projectPath'],
        ) ??
        'No project';
    return Scaffold(
      backgroundColor: _OlTheme.bg,
      appBar: AppBar(
        title: const Text('Session'),
        backgroundColor: _OlTheme.bg,
        foregroundColor: _OlTheme.ink,
        elevation: 0,
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 680),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              children: [
                _Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        session['title']?.toString() ?? 'Agent session',
                        style: const TextStyle(
                          fontSize: 25,
                          height: 1.08,
                          letterSpacing: -0.6,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 7),
                      Text(
                        '$agentName · $project · ${_formatDuration(session['duration_seconds'] ?? session['durationSeconds'])} · ${_formatDateTime(session['last_activity_at'] ?? session['lastActivityAt'])}',
                        style: const TextStyle(
                          color: _OlTheme.dim,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 14),
                      Text(
                        session['summary']?.toString() ??
                            'Session captured by Leash.',
                        style: const TextStyle(
                          color: _OlTheme.ink2,
                          height: 1.35,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 14),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          _Pill(icon: Icons.folder_outlined, label: project),
                          _Pill(
                            icon: Icons.timer_outlined,
                            label: _formatDuration(
                              session['duration_seconds'] ??
                                  session['durationSeconds'],
                            ),
                          ),
                          _Pill(
                            icon: Icons.account_tree_outlined,
                            label:
                                '${_formatDuration(session['subagent_seconds'] ?? session['subagentSeconds'])} subagents',
                          ),
                          _Pill(
                            icon: Icons.list_alt,
                            label:
                                '${session['event_count'] ?? session['eventCount'] ?? events.length} events',
                          ),
                          _Pill(
                            icon: Icons.pending_actions,
                            label:
                                '${session['approval_count'] ?? session['approvalCount'] ?? 0} approvals',
                          ),
                          for (final server in mcpServers)
                            _Pill(icon: Icons.hub_outlined, label: server),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                const _SectionTitle('What happened'),
                const SizedBox(height: 8),
                _Panel(
                  child: events.isEmpty
                      ? const Text(
                          'No event details captured for this session.',
                          style: TextStyle(
                            color: _OlTheme.dim,
                            fontWeight: FontWeight.w700,
                          ),
                        )
                      : Column(
                          children: [
                            for (
                              var index = 0;
                              index < events.length;
                              index++
                            ) ...[
                              _AgentActionRow(item: events[index]),
                              if (index != events.length - 1)
                                const Divider(height: 18),
                            ],
                          ],
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AttentionEventRow extends StatelessWidget {
  const _AttentionEventRow({required this.event});

  final Map event;

  @override
  Widget build(BuildContext context) {
    final kind = event['kind']?.toString() ?? 'completed';
    final icon = switch (kind) {
      'blocked' => Icons.block_rounded,
      'subagent_completed' => Icons.account_tree_rounded,
      'completed' => Icons.task_alt_rounded,
      _ => Icons.notifications_active_outlined,
    };
    final color = kind == 'blocked' ? _OlTheme.danger : _OlTheme.ok;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 22),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  event['title']?.toString() ?? 'Agent update',
                  style: const TextStyle(fontWeight: FontWeight.w800),
                ),
                if (event['body']?.toString().trim().isNotEmpty ?? false) ...[
                  const SizedBox(height: 3),
                  Text(
                    event['body'].toString(),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: _OlTheme.dim),
                  ),
                ],
                const SizedBox(height: 3),
                Text(
                  _relativeTime(event['createdAt']),
                  style: const TextStyle(
                    color: _OlTheme.mute,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({required this.item});

  final Map item;

  @override
  Widget build(BuildContext context) {
    final agent =
        item['agent_name']?.toString() ??
        item['agentName']?.toString() ??
        'Agent';
    final summary = _eventSummary(item);
    final decision =
        item['resolution']?.toString() ??
        item['decision']?.toString() ??
        'logged';
    final rawCreatedAt = item['created_at'] ?? item['createdAt'];
    final createdAt = _relativeTime(rawCreatedAt);
    final exactTime = _formatHistoryDateTime(rawCreatedAt);
    final project =
        _projectNameFromAny(item['project_name'] ?? item['projectName']) ??
        _projectNameFromAny(item['project_path'] ?? item['projectPath']);
    final evidence = _historyEvidence(item);
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => _openEventDetail(context, item),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                color: _decisionColor(decision).withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(
                _decisionIcon(decision),
                size: 18,
                color: _decisionColor(decision),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    summary,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w900),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    agent,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: _OlTheme.dim,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if (project != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      project,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: _OlTheme.dim,
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                  if (evidence != null) ...[
                    const SizedBox(height: 7),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: _OlTheme.surfaceRaised,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        'What it touched: $evidence',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: _OlTheme.dim,
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 2),
                  Text(
                    '$createdAt · $exactTime',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: _OlTheme.mute,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.only(top: 5),
              child: Icon(Icons.chevron_right, color: _OlTheme.mute, size: 22),
            ),
          ],
        ),
      ),
    );
  }
}

void _openEventDetail(BuildContext context, Map item) {
  Navigator.of(
    context,
  ).push(MaterialPageRoute(builder: (_) => _EventDetailPage(item: item)));
}

class _EventDetailPage extends StatelessWidget {
  const _EventDetailPage({required this.item});

  final Map item;

  @override
  Widget build(BuildContext context) {
    final agent =
        item['agent_name']?.toString() ??
        item['agentName']?.toString() ??
        item['display_name']?.toString() ??
        item['displayName']?.toString() ??
        'Agent';
    final decision =
        item['resolution']?.toString() ??
        item['decision']?.toString() ??
        'logged';
    final summary = _eventSummary(item);
    final project =
        _projectNameFromAny(item['project_name'] ?? item['projectName']) ??
        _projectNameFromAny(item['project_path'] ?? item['projectPath']) ??
        'No project';
    final rawCreatedAt =
        item['created_at'] ??
        item['createdAt'] ??
        item['activity_at'] ??
        item['activityAt'];
    final createdAt = _formatHistoryDateTime(rawCreatedAt);
    final relativeCreatedAt = _relativeTime(rawCreatedAt);
    final policies =
        ((item['triggered_policies'] as List?) ??
                (item['triggeredPolicies'] as List?) ??
                const [])
            .whereType<Map>()
            .toList();
    final purpose = _eventPurpose(item);
    final prompt = _eventPrompt(item);

    return Scaffold(
      backgroundColor: _OlTheme.bg,
      appBar: AppBar(
        title: const Text('What happened'),
        backgroundColor: _OlTheme.bg,
        foregroundColor: _OlTheme.ink,
        elevation: 0,
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 680),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              children: [
                _Panel(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Container(
                            width: 44,
                            height: 44,
                            decoration: BoxDecoration(
                              color: _decisionColor(
                                decision,
                              ).withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: Icon(
                              _decisionIcon(decision),
                              color: _decisionColor(decision),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  summary,
                                  style: const TextStyle(
                                    fontSize: 22,
                                    height: 1.08,
                                    letterSpacing: -0.4,
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                                const SizedBox(height: 7),
                                Text(
                                  '$agent · $relativeCreatedAt\n$createdAt',
                                  style: const TextStyle(
                                    color: _OlTheme.dim,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          _Pill(icon: Icons.folder_outlined, label: project),
                          _Pill(
                            icon: Icons.bolt_outlined,
                            label: _friendlyAction(item),
                          ),
                          _Pill(icon: Icons.rule_rounded, label: decision),
                        ],
                      ),
                    ],
                  ),
                ),
                if (policies.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  const _SectionTitle('Policies'),
                  const SizedBox(height: 8),
                  _Panel(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (
                          var index = 0;
                          index < policies.length;
                          index++
                        ) ...[
                          _PolicyDetail(policy: policies[index]),
                          if (index != policies.length - 1)
                            const Divider(height: 20),
                        ],
                      ],
                    ),
                  ),
                ],
                if (purpose != null || prompt != null) ...[
                  const SizedBox(height: 16),
                  const _SectionTitle('Context'),
                  const SizedBox(height: 8),
                  _Panel(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (purpose != null) ...[
                          const Text(
                            'Why this happened',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            purpose,
                            style: const TextStyle(
                              color: _OlTheme.ink2,
                              height: 1.35,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                        if (purpose != null && prompt != null)
                          const Divider(height: 24),
                        if (prompt != null) ...[
                          const Text(
                            'Prompt',
                            style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            prompt,
                            style: const TextStyle(
                              color: _OlTheme.dim,
                              height: 1.35,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PolicyDetail extends StatelessWidget {
  const _PolicyDetail({required this.policy});

  final Map policy;

  @override
  Widget build(BuildContext context) {
    final name =
        policy['policy_name']?.toString() ??
        policy['policyName']?.toString() ??
        'Policy';
    final explanation = policy['explanation']?.toString() ?? '';
    final evidence =
        (policy['evidence'] as List?)
            ?.map((item) => item.toString())
            .toList() ??
        const <String>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          name,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w900),
        ),
        if (explanation.isNotEmpty) ...[
          const SizedBox(height: 5),
          Text(
            explanation,
            style: const TextStyle(
              color: _OlTheme.ink2,
              height: 1.35,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
        if (evidence.isNotEmpty) ...[
          const SizedBox(height: 10),
          for (final item in evidence)
            Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Text(
                '"$item"',
                style: const TextStyle(
                  color: _OlTheme.dim,
                  height: 1.3,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
        ],
      ],
    );
  }
}

String _agentName(Map agent) {
  return agent['display_name']?.toString() ??
      agent['displayName']?.toString() ??
      agent['kind']?.toString() ??
      'Agent';
}

String _agentKindLabel(Map agent) {
  final raw = _canonicalAgentKind(agent);
  if (raw == 'claude-code') return 'Claude Code';
  if (raw == 'github-copilot') return 'GitHub Copilot';
  if (raw == 'gemini') return 'Google Gemini CLI';
  if (raw == 'opencode') return 'OpenCode';
  if (raw == 'codex') return 'OpenAI Codex';
  if (raw == 'cline') return 'Cline';
  if (raw == 'cursor') return 'Cursor';
  if (raw == 'windsurf') return 'Windsurf';
  if (raw == 'openclaw') return 'OpenClaw';
  if (raw == 'nanoclaw') return 'NanoClaw';
  if (raw == 'salesforce') return 'Salesforce';
  return raw.replaceAll('-', ' ');
}

String _agentIconAsset(Map agent) {
  switch (_canonicalAgentKind(agent)) {
    case 'claude-code':
      return 'assets/agents/claude.png';
    case 'github-copilot':
      return 'assets/agents/githubcopilot.png';
    case 'gemini':
      return 'assets/agents/googlegemini.png';
    case 'opencode':
      return 'assets/agents/opencode.png';
    case 'codex':
      return 'assets/agents/codex.png';
    case 'cline':
      return 'assets/agents/cline.png';
    case 'cursor':
      return 'assets/agents/cursor.png';
    case 'windsurf':
      return 'assets/agents/windsurf.png';
    case 'openclaw':
    case 'nanoclaw':
      return 'assets/agents/openclaw.png';
    default:
      return 'assets/agents/unknown.png';
  }
}

String _canonicalAgentKind(Map agent) {
  final text =
      '${agent['kind'] ?? ''} ${agent['agent_kind'] ?? ''} ${agent['agentKind'] ?? ''} ${_agentName(agent)}'
          .toLowerCase();
  if (text.contains('claude') || text.contains('anthropic')) {
    return 'claude-code';
  }
  if (text.contains('github copilot') || text.contains('copilot')) {
    return 'github-copilot';
  }
  if (text.contains('gemini')) return 'gemini';
  if (text.contains('opencode')) return 'opencode';
  if (text.contains('codex') || text.contains('openai')) return 'codex';
  if (text.contains('cline')) return 'cline';
  if (text.contains('cursor')) return 'cursor';
  if (text.contains('windsurf')) return 'windsurf';
  if (text.contains('openclaw')) return 'openclaw';
  if (text.contains('nanoclaw')) return 'nanoclaw';
  if (text.contains('salesforce')) return 'salesforce';
  return text.trim().replaceAll(RegExp(r'\s+'), '-');
}

int _compareAgentsByCanonicalOrder(Map left, Map right) {
  final leftIndex = _canonicalAgentOrder.indexOf(_canonicalAgentKind(left));
  final rightIndex = _canonicalAgentOrder.indexOf(_canonicalAgentKind(right));
  final normalizedLeft = leftIndex < 0
      ? _canonicalAgentOrder.length
      : leftIndex;
  final normalizedRight = rightIndex < 0
      ? _canonicalAgentOrder.length
      : rightIndex;
  if (normalizedLeft != normalizedRight) {
    return normalizedLeft - normalizedRight;
  }
  return _agentName(left).compareTo(_agentName(right));
}

const _canonicalAgentOrder = [
  'claude-code',
  'github-copilot',
  'gemini',
  'opencode',
  'codex',
  'cline',
  'cursor',
  'windsurf',
];

dynamic _agentActivityAt(Map agent) {
  return agent['activity_at'] ??
      agent['activityAt'] ??
      agent['created_at'] ??
      agent['createdAt'] ??
      agent['last_seen_at'] ??
      agent['lastSeenAt'];
}

String _agentStatus(Map agent) {
  return agent['resolution']?.toString() ??
      agent['decision']?.toString() ??
      'active';
}

int _agentNodeCount(Map agent) {
  final sessions = _agentSessions(agent);
  final sessionCount = sessions.length;
  final host = agent['hostname']?.toString();
  final nodes = sessions
      .map((session) => session['hostname']?.toString())
      .where((value) => value != null && value.trim().isNotEmpty)
      .toSet()
      .length;
  if (nodes > 0) return nodes;
  if (sessionCount > 0) return sessionCount;
  return host == null || host.isEmpty ? 0 : 1;
}

String _sessionStream(Map? session, Map agent) {
  final events = ((session?['events'] as List?) ?? const [])
      .whereType<Map>()
      .toList();
  final latest = events.isNotEmpty ? events.first : agent;
  final prompt = _eventPrompt(latest);
  if (prompt != null) return _truncate(prompt, 58);
  final purpose = _eventPurpose(latest);
  if (purpose != null) return _truncate(purpose, 58);
  final summary =
      latest['summary']?.toString() ??
      session?['summary']?.toString() ??
      _agentSummary(agent);
  return _truncate(summary, 58);
}

String _shortSyncId(Object? value) {
  final raw = value?.toString() ?? 'local';
  final cleaned = raw.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').toUpperCase();
  if (cleaned.isEmpty) return 'LOCAL';
  return cleaned.length <= 8 ? cleaned : cleaned.substring(cleaned.length - 8);
}

String _statusCopy(String status) {
  final value = status.toLowerCase();
  if (value == 'ask') return 'live waiting';
  if (value == 'deny' || value == 'denied') return 'blocked';
  if (value == 'allow' || value == 'approved') return 'live running';
  if (value.contains('upgrade')) return 'upgrading';
  return 'live running';
}

_AgentTint _agentTint(String status) {
  final value = status.toLowerCase();
  if (value == 'ask') {
    return const _AgentTint(
      card: _OlTheme.surface,
      surface: _OlTheme.attentionSoft,
      border: Color(0xff614217),
      text: _OlTheme.attention,
      dot: _OlTheme.attention,
    );
  }
  if (value == 'deny' || value == 'denied') {
    return const _AgentTint(
      card: _OlTheme.surface,
      surface: _OlTheme.dangerSoft,
      border: Color(0xff652925),
      text: _OlTheme.danger,
      dot: _OlTheme.danger,
    );
  }
  return const _AgentTint(
    card: _OlTheme.surface,
    surface: _OlTheme.okSoft,
    border: Color(0xff1d5d45),
    text: _OlTheme.ok,
    dot: _OlTheme.ok,
  );
}

class _AgentTint {
  const _AgentTint({
    required this.card,
    required this.surface,
    required this.border,
    required this.text,
    required this.dot,
  });

  final Color card;
  final Color surface;
  final Color border;
  final Color text;
  final Color dot;
}

String _agentSummary(Map agent) {
  final summary =
      agent['short_summary']?.toString() ??
      agent['shortSummary']?.toString() ??
      agent['decision_summary']?.toString() ??
      agent['decisionSummary']?.toString();
  if (summary != null &&
      summary.trim().isNotEmpty &&
      !_isBoringSummary(summary)) {
    return summary;
  }
  final purpose = _eventPurpose(agent);
  if (purpose != null) return purpose;
  final prompt = _eventPrompt(agent);
  if (prompt != null) return 'Prompt: ${_truncate(prompt, 100)}';
  final target = _eventTarget(agent);
  if (target != null) return '${_friendlyAction(agent)} on $target';
  return _friendlyAction(agent);
}

String _friendlyAction(Map agent) {
  final tool = agent['tool_name']?.toString() ?? agent['toolName']?.toString();
  final event =
      agent['event_name']?.toString() ?? agent['eventName']?.toString();
  if (tool != null && tool.isNotEmpty) return 'Using $tool';
  if (event == 'UserPromptSubmit') return 'Reading prompt';
  if (event == 'PreToolUse' || event == 'PostToolUse') return 'Using tool';
  if (event == 'Stop') return 'Session ended';
  return event?.isNotEmpty == true ? event! : 'Connected';
}

String _eventSummary(Map item) {
  final summary = item['summary']?.toString();
  if (summary != null &&
      summary.trim().isNotEmpty &&
      !_isBoringSummary(summary)) {
    return summary.trim();
  }
  final question = item['question']?.toString();
  if (question != null && question.trim().isNotEmpty) return question.trim();
  final purpose = _eventPurpose(item);
  if (purpose != null) return purpose;
  final prompt = _eventPrompt(item);
  if (prompt != null) return 'Prompt: ${_truncate(prompt, 110)}';
  final target = _eventTarget(item);
  if (target != null) return '${_friendlyAction(item)} on $target';
  return _friendlyAction(item);
}

bool _isVisibleAgent(Map item) {
  if (_agentSessions(item).isNotEmpty) return true;
  final event =
      item['event_name']?.toString() ?? item['eventName']?.toString() ?? '';
  if (event == 'Stop') return false;
  final date = DateTime.tryParse(_agentActivityAt(item)?.toString() ?? '');
  if (date == null) return false;
  return DateTime.now().difference(date.toLocal()) <
      const Duration(seconds: 90);
}

bool _isInterestingActivity(Map item) {
  final event =
      item['event_name']?.toString() ?? item['eventName']?.toString() ?? '';
  if (event == 'Stop') return false;
  final summary = item['summary']?.toString();
  if (_isBoringSummary(summary)) return false;
  final decision = item['decision']?.toString();
  final resolution = item['resolution']?.toString();
  if (decision == 'ask' || decision == 'deny' || resolution == 'deny') {
    return true;
  }
  return _triggeredPolicies(item).isNotEmpty;
}

List<Map> _agentSessions(Map item) {
  return ((item['sessions'] as List?) ?? const []).whereType<Map>().toList();
}

bool _isBoringSummary(String? summary) {
  return summary != null &&
      RegExp(
        r'all active policies passed',
        caseSensitive: false,
      ).hasMatch(summary);
}

List<Map> _triggeredPolicies(Map item) {
  return ((item['triggered_policies'] as List?) ??
          (item['triggeredPolicies'] as List?) ??
          const [])
      .whereType<Map>()
      .toList();
}

String? _eventPurpose(Map item) {
  final direct =
      item['purpose_summary']?.toString() ?? item['purposeSummary']?.toString();
  if (direct != null && direct.trim().isNotEmpty) return direct.trim();
  final payload = item['payload'];
  if (payload is Map) {
    final purpose = payload['openleashPurposeSummary']?.toString();
    if (purpose != null && purpose.trim().isNotEmpty) return purpose.trim();
  }
  return null;
}

String? _eventPrompt(Map item) {
  final direct = item['prompt']?.toString();
  if (direct != null && direct.trim().isNotEmpty) return direct.trim();
  final payload = item['payload'];
  if (payload is Map) {
    final prompt = payload['prompt']?.toString();
    if (prompt != null && prompt.trim().isNotEmpty) return prompt.trim();
  }
  return null;
}

String? _eventTarget(Map item) {
  final payload = item['payload'];
  if (payload is! Map) return null;
  final tool = payload['tool'];
  if (tool is! Map) return null;
  final input = tool['input'];
  if (input is! Map) return null;
  final target =
      input['file_path'] ?? input['path'] ?? input['command'] ?? input['url'];
  final value = target?.toString();
  return value == null || value.trim().isEmpty
      ? null
      : _truncate(value.trim(), 80);
}

String? _historyEvidence(Map item) {
  final target = _eventTarget(item);
  if (target != null) return target;
  final evidence = item['evidence'];
  if (evidence is List) {
    for (final entry in evidence.whereType<Map>()) {
      final value = entry['value']?.toString().trim();
      if (value != null && value.isNotEmpty) return _truncate(value, 120);
    }
  }
  final policies = _triggeredPolicies(item);
  for (final policy in policies) {
    final explanation = policy['explanation']?.toString().trim();
    if (explanation != null && explanation.isNotEmpty) {
      return _truncate(explanation, 120);
    }
  }
  return null;
}

String? _projectNameFromAny(dynamic raw) {
  final value = raw?.toString();
  if (value == null || value.trim().isEmpty) return null;
  final normalized = value.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');
  final parts = normalized.split('/').where((part) => part.isNotEmpty);
  return parts.isEmpty ? normalized : parts.last;
}

String _relativeTime(dynamic raw) {
  final date = DateTime.tryParse(raw?.toString() ?? '');
  if (date == null) return 'new';
  final diff = DateTime.now().difference(date.toLocal());
  if (diff.inMinutes < 1) return 'now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m';
  if (diff.inHours < 24) return '${diff.inHours}h';
  return DateFormat.MMMd().format(date.toLocal());
}

String _formatDateTime(dynamic raw) {
  final date = DateTime.tryParse(raw?.toString() ?? '');
  if (date == null) return 'Unknown time';
  return DateFormat.MMMd().add_jm().format(date.toLocal());
}

String _formatHistoryDateTime(dynamic raw) {
  final date = DateTime.tryParse(raw?.toString() ?? '');
  if (date == null) return 'Unknown time';
  return DateFormat.yMMMd().add_jms().format(date.toLocal());
}

String _formatDuration(dynamic raw) {
  final total = (num.tryParse(raw?.toString() ?? '') ?? 0).round();
  if (total < 60) return total > 0 ? '${total}s' : '0s';
  final minutes = total ~/ 60;
  if (minutes < 60) return '${minutes}m';
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  return rest > 0 ? '${hours}h ${rest}m' : '${hours}h';
}

String _truncate(String value, int max) {
  if (value.length <= max) return value;
  return '${value.substring(0, max - 1)}…';
}

Color _decisionColor(String decision) {
  if (decision == 'allow' || decision == 'allowed') {
    return _OlTheme.ok;
  }
  if (decision == 'deny' || decision == 'denied') {
    return _OlTheme.danger;
  }
  if (decision == 'ask') return const Color(0xffa45f00);
  return _OlTheme.dim;
}

IconData _decisionIcon(String decision) {
  if (decision == 'allow' || decision == 'allowed') {
    return Icons.check_circle_outline;
  }
  if (decision == 'deny' || decision == 'denied') return Icons.block;
  if (decision == 'ask') return Icons.pending_actions;
  return Icons.history;
}

class _ApprovalCard extends StatefulWidget {
  const _ApprovalCard({
    required this.approval,
    required this.onAllow,
    required this.onDeny,
  });

  final Approval approval;
  final ValueChanged<Map<String, dynamic>?> onAllow;
  final ValueChanged<String?> onDeny;

  @override
  State<_ApprovalCard> createState() => _ApprovalCardState();
}

class _ApprovalCardState extends State<_ApprovalCard> {
  final _guidanceController = TextEditingController();
  final Map<String, dynamic> _answers = {};

  List<Map<String, dynamic>> get _questions {
    final raw = widget.approval.interaction?['questions'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .where((item) => (item['question']?.toString().trim() ?? '').isNotEmpty)
        .toList();
  }

  bool get _allQuestionsAnswered => _questions.every((question) {
    final answer = _answers[question['question']?.toString()];
    return answer is List
        ? answer.isNotEmpty
        : answer?.toString().trim().isNotEmpty == true;
  });

  void _toggleAnswer(
    String question,
    String option, {
    required bool multiSelect,
  }) {
    setState(() {
      if (!multiSelect) {
        _answers[question] = option;
        return;
      }
      final selected = <String>{
        ...((_answers[question] is List)
            ? (_answers[question] as List).map((item) => item.toString())
            : const <String>[]),
      };
      selected.contains(option)
          ? selected.remove(option)
          : selected.add(option);
      _answers[question] = selected.toList();
    });
  }

  @override
  void dispose() {
    _guidanceController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final approval = widget.approval;
    final supportsGuidance = _supportsAgentGuidance(approval.agentKind);
    final headline = approval.isQuestion
        ? '${approval.agent} asks'
        : approval.isPlan
        ? 'Review ${approval.agent}’s plan'
        : 'Allow ${approval.agent}?';
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: _OlTheme.surface.withValues(alpha: 0.98),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: _OlTheme.attention.withValues(alpha: 0.72),
          width: 1.2,
        ),
        boxShadow: [
          ..._OlTheme.panelShadow,
          BoxShadow(
            color: _OlTheme.attention.withValues(alpha: 0.08),
            blurRadius: 22,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  headline,
                  style: const TextStyle(
                    fontSize: 25,
                    height: 1.05,
                    letterSpacing: -0.5,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: _OlTheme.attention,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  approval.isQuestion
                      ? 'QUESTION'
                      : approval.isPlan
                      ? 'PLAN'
                      : 'APPROVAL',
                  style: const TextStyle(
                    color: _OlTheme.bg,
                    fontSize: 10,
                    letterSpacing: 0.7,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            approval.title,
            style: const TextStyle(
              fontSize: 15,
              height: 1.4,
              color: _OlTheme.ink2,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (approval.purpose?.trim().isNotEmpty ?? false) ...[
            const SizedBox(height: 12),
            _PurposeBox(text: approval.purpose!.trim()),
          ],
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _Pill(icon: Icons.folder_outlined, label: approval.project),
              _Pill(icon: Icons.extension_outlined, label: approval.plugin),
              _Pill(
                icon: Icons.schedule,
                label: DateFormat.MMMd().add_jm().format(approval.createdAt),
              ),
            ],
          ),
          if ((approval.quote?.trim().isNotEmpty ?? false) ||
              approval.context.isNotEmpty) ...[
            const SizedBox(height: 14),
            _ApprovalContextBox(approval: approval),
          ],
          if (approval.isQuestion) ...[
            const SizedBox(height: 14),
            ..._questions.map((question) {
              final prompt = question['question']!.toString();
              final multiSelect = question['multiSelect'] == true;
              final options = ((question['options'] as List?) ?? const [])
                  .whereType<Map>()
                  .map((item) => item['label']?.toString() ?? '')
                  .where((item) => item.isNotEmpty)
                  .toList();
              final answer = _answers[prompt];
              return Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      prompt,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    if (options.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: options.map((option) {
                          final selected = multiSelect
                              ? answer is List && answer.contains(option)
                              : answer == option;
                          return FilterChip(
                            label: Text(option),
                            selected: selected,
                            onSelected: (_) => _toggleAnswer(
                              prompt,
                              option,
                              multiSelect: multiSelect,
                            ),
                          );
                        }).toList(),
                      ),
                    ],
                    const SizedBox(height: 8),
                    TextField(
                      onChanged: (value) => setState(() {
                        final cleaned = value.trim();
                        if (cleaned.isEmpty) {
                          _answers.remove(prompt);
                        } else {
                          _answers[prompt] = cleaned;
                        }
                      }),
                      decoration: InputDecoration(
                        hintText: options.isEmpty
                            ? 'Type your answer'
                            : 'Or type another answer',
                        filled: true,
                        fillColor: _OlTheme.bg2,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                    ),
                  ],
                ),
              );
            }),
            if (_questions.isEmpty)
              TextField(
                onChanged: (value) => setState(() {
                  final cleaned = value.trim();
                  if (cleaned.isEmpty) {
                    _answers.remove('answer');
                  } else {
                    _answers['answer'] = cleaned;
                  }
                }),
                decoration: const InputDecoration(
                  hintText: 'Type your answer',
                  filled: true,
                  fillColor: _OlTheme.bg2,
                ),
              ),
          ] else if (approval.isPlan) ...[
            if (approval.interaction?['markdown']
                    ?.toString()
                    .trim()
                    .isNotEmpty ??
                false) ...[
              const SizedBox(height: 14),
              _PurposeBox(text: approval.interaction!['markdown'].toString()),
            ],
            const SizedBox(height: 14),
            TextField(
              controller: _guidanceController,
              onChanged: (_) => setState(() {}),
              maxLength: 500,
              maxLines: 3,
              decoration: const InputDecoration(
                hintText: 'Feedback if the agent should revise the plan',
                filled: true,
                fillColor: _OlTheme.bg2,
              ),
            ),
          ] else if (supportsGuidance) ...[
            const SizedBox(height: 14),
            TextField(
              controller: _guidanceController,
              onChanged: (_) => setState(() {}),
              maxLength: 500,
              maxLines: 3,
              decoration: InputDecoration(
                hintText: 'Tell the agent what to do instead (Optional)',
                filled: true,
                fillColor: _OlTheme.bg2,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: _OlTheme.line2),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(color: _OlTheme.line2),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: const BorderSide(
                    color: _OlTheme.accent,
                    width: 1.4,
                  ),
                ),
              ),
            ),
          ],
          const SizedBox(height: 16),
          if (approval.isQuestion)
            _PrimaryButton(
              label: 'Send answer',
              icon: Icons.send_rounded,
              onPressed:
                  (_questions.isEmpty
                      ? (_answers['answer']?.toString().trim().isNotEmpty ==
                            true)
                      : _allQuestionsAnswered)
                  ? () => widget.onAllow({
                      ...approval.originalInput,
                      'answers': _answers,
                    })
                  : null,
            )
          else
            Row(
              children: [
                Expanded(
                  child: _DecisionButton(
                    allow: false,
                    label: approval.isPlan
                        ? 'Request changes'
                        : _guidanceController.text.trim().isEmpty
                        ? 'Deny'
                        : 'Deny & guide',
                    onPressed: () => widget.onDeny(_guidanceController.text),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _DecisionButton(
                    allow: true,
                    label: approval.isPlan ? 'Approve plan' : 'Allow',
                    onPressed:
                        approval.isPlan ||
                            _guidanceController.text.trim().isEmpty
                        ? () => widget.onAllow(
                            approval.isPlan ? approval.originalInput : null,
                          )
                        : null,
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _DecisionButton extends StatelessWidget {
  const _DecisionButton({
    required this.allow,
    required this.label,
    required this.onPressed,
  });

  final bool allow;
  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final background = allow ? _OlTheme.ok : _OlTheme.dangerSoft;
    final foreground = allow ? _OlTheme.bg : _OlTheme.ink;
    final border = allow ? _OlTheme.ok : _OlTheme.danger;
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: background,
        foregroundColor: foreground,
        disabledBackgroundColor: background.withValues(alpha: 0.34),
        disabledForegroundColor: foreground.withValues(alpha: 0.5),
        minimumSize: const Size.fromHeight(50),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        side: BorderSide(color: border.withValues(alpha: 0.8)),
      ),
      onPressed: onPressed,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(allow ? Icons.check_rounded : Icons.close_rounded, size: 18),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w900),
            ),
          ),
        ],
      ),
    );
  }
}

class _ApprovalContextBox extends StatelessWidget {
  const _ApprovalContextBox({required this.approval});

  final Approval approval;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: Container(
        decoration: BoxDecoration(
          color: _OlTheme.surfaceRaised,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: _OlTheme.attention.withValues(alpha: 0.26)),
        ),
        child: ExpansionTile(
          initiallyExpanded: true,
          tilePadding: const EdgeInsets.symmetric(horizontal: 14),
          childrenPadding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          title: const Text(
            'More context',
            style: TextStyle(fontWeight: FontWeight.w900),
          ),
          subtitle: approval.quote == null || approval.quote!.trim().isEmpty
              ? null
              : Text(
                  '"${approval.quote!.trim()}"',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: _OlTheme.dim,
                    fontWeight: FontWeight.w700,
                  ),
                ),
          children: [
            if (approval.quote != null && approval.quote!.trim().isNotEmpty)
              _ContextQuote(text: approval.quote!.trim()),
            if (approval.context.isNotEmpty) ...[
              const SizedBox(height: 10),
              for (final item in approval.context) _ContextLine(line: item),
            ],
          ],
        ),
      ),
    );
  }
}

class _PurposeBox extends StatelessWidget {
  const _PurposeBox({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: _OlTheme.surfaceRaised,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _OlTheme.attention.withValues(alpha: 0.24)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Why now',
            style: TextStyle(
              color: _OlTheme.accent,
              fontSize: 12,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 5),
          Text(
            text,
            style: const TextStyle(
              color: _OlTheme.ink2,
              height: 1.35,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}

class _ContextQuote extends StatelessWidget {
  const _ContextQuote({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Text(
        '"$text"',
        style: const TextStyle(
          color: _OlTheme.ink2,
          fontSize: 15,
          height: 1.35,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _ContextLine extends StatelessWidget {
  const _ContextLine({required this.line});

  final ApprovalContextLine line;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(
              line.role,
              style: const TextStyle(
                color: _OlTheme.dim,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
          Expanded(
            child: Text(
              line.content,
              style: const TextStyle(
                color: _OlTheme.ink2,
                height: 1.35,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: _OlTheme.accentSoft,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: _OlTheme.accent.withValues(alpha: 0.42)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 18, color: _OlTheme.accent),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 240),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontWeight: FontWeight.w800,
                color: _OlTheme.accent,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
