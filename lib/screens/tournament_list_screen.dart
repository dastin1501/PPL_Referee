import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';
import 'profile_screen.dart';
import 'settings_screen.dart';

class TournamentListScreen extends StatefulWidget {
  const TournamentListScreen({super.key});

  @override
  State<TournamentListScreen> createState() => _TournamentListScreenState();
}

class _TournamentListScreenState extends State<TournamentListScreen> {
  bool _navigating = false;

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('My Tournaments'),
        backgroundColor: Colors.white,
        foregroundColor: Colors.black87,
        elevation: 0,
        centerTitle: true,
      ),
      drawer: Drawer(
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            UserAccountsDrawerHeader(
              accountName: Text(app.currentUser?.name ?? 'Referee'),
              accountEmail: Text(app.currentUser?.email ?? ''),
              currentAccountPicture: const CircleAvatar(
                backgroundColor: Color.fromARGB(255, 26, 161, 123),
                child: Icon(Icons.person, color: Colors.white),
              ),
              decoration: const BoxDecoration(color: Color.fromARGB(255, 26, 161, 123)),
            ),
            ListTile(
              leading: const Icon(Icons.person_outline),
              title: const Text('Profile'),
              onTap: () {
                Navigator.pop(context);
                Navigator.push(
                  context,
                  MaterialPageRoute(builder: (context) => const ProfileScreen()),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.settings_outlined),
              title: const Text('Settings'),
              onTap: () {
                Navigator.pop(context);
                Navigator.push(
                  context,
                  MaterialPageRoute(builder: (context) => const SettingsScreen()),
                );
              },
            ),
            const Divider(),
            ListTile(
              leading: const Icon(Icons.logout, color: Colors.red),
              title: const Text('Log out', style: TextStyle(color: Colors.red)),
              onTap: () async {
                Navigator.pop(context);
                await app.logout();
                if (context.mounted) {
                  Navigator.pushReplacementNamed(context, '/login');
                }
              },
            ),
          ],
        ),
      ),
      body: RefreshIndicator(
        color: const Color.fromARGB(255, 26, 161, 123),
        onRefresh: () => app.loadTournaments(),
        child: app.error != null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(16.0),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.error_outline, color: Colors.red, size: 48),
                      const SizedBox(height: 16),
                      Text(
                        app.error!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Colors.red),
                      ),
                      const SizedBox(height: 16),
                      ElevatedButton(
                        onPressed: () => app.loadTournaments(),
                        style: ElevatedButton.styleFrom(
                          backgroundColor: const Color.fromARGB(255, 26, 161, 123),
                          foregroundColor: Colors.white,
                        ),
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              )
            : app.tournaments.isEmpty && !app.loading
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.calendar_today, color: Colors.grey, size: 40),
                        const SizedBox(height: 12),
                        const Text('No tournaments found.'),
                        const SizedBox(height: 16),
                        ElevatedButton(
                          onPressed: () => app.loadTournaments(),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color.fromARGB(255, 26, 161, 123),
                            foregroundColor: Colors.white,
                          ),
                          child: const Text('Refresh'),
                        ),
                      ],
                    ),
                  )
                : ListView.separated(
                    padding: const EdgeInsets.all(16),
                    itemCount: app.tournaments.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 12),
                    itemBuilder: (_, i) {
                      final t = app.tournaments[i];
                      return InkWell(
                        onTap: () async {
                          if (_navigating) return;
                          setState(() => _navigating = true);
                          await app.selectTournament(t);
                          if (!mounted) return;
                          Navigator.pushNamed(context, '/courtGames').then((_) {
                            if (mounted) setState(() => _navigating = false);
                          });
                        },
                        borderRadius: BorderRadius.circular(16),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(color: Colors.grey.shade300),
                          ),
                          child: Row(
                            children: [
                              const Icon(Icons.emoji_events_outlined, color: Color.fromARGB(255, 26, 161, 123)),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  t.name,
                                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                                ),
                              ),
                              const Icon(Icons.chevron_right, color: Colors.grey),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
      ),
    );
  }
}
