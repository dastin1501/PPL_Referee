import 'package:flutter/material.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:provider/provider.dart';
import 'state/app_state.dart';
import 'screens/login_screen.dart';
import 'screens/signup_screen.dart';
import 'screens/tournament_list_screen.dart';
import 'screens/court_games_screen.dart';
import 'screens/referee_dashboard_screen.dart';
import 'widgets/global_sync_indicator.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await dotenv.load(fileName: 'assets/config/.env');
  } catch (_) {}
  runApp(const RefereeApp());
}

class RefereeApp extends StatefulWidget {
  const RefereeApp({super.key});

  @override
  State<RefereeApp> createState() => _RefereeAppState();
}

class _RefereeAppState extends State<RefereeApp> with WidgetsBindingObserver {
  AppState? _appState;
  final _navigatorKey = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _appState?.refreshOnResume();
    }
  }

  @override
  Widget build(BuildContext context) {
    // MaterialApp must NOT sit inside a Consumer — rebuilding it on every
    // AppState.notifyListeners() disposes the tournament list and drops navigation.
    return ChangeNotifierProvider(
      create: (_) {
        final app = AppState()..init();
        _appState = app;
        return app;
      },
      child: MaterialApp(
        title: 'PPL REFEREE',
        navigatorKey: _navigatorKey,
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
          useMaterial3: true,
        ),
        builder: (context, child) {
          return Consumer<AppState>(
            builder: (context, app, _) {
              return Stack(
                children: [
                  if (child != null) child,
                  if (app.currentUser != null) const GlobalSyncIndicator(),
                ],
              );
            },
          );
        },
        home: const _SessionGate(),
        routes: {
          '/login': (_) => const LoginScreen(),
          '/signup': (_) => const SignupScreen(),
          '/tournaments': (_) => const TournamentListScreen(),
          '/courtGames': (_) => const CourtGamesScreen(),
          '/dashboard': (_) => const RefereeDashboardScreen(),
        },
      ),
    );
  }
}

class _SessionGate extends StatelessWidget {
  const _SessionGate();

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    if (!app.initialized) {
      return const Scaffold(
        body: Center(
          child: CircularProgressIndicator(),
        ),
      );
    }
    if (app.currentUser != null) {
      return const TournamentListScreen();
    }
    return const LoginScreen();
  }
}
