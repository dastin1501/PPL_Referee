import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';
import 'profile_screen.dart';

class TournamentListScreen extends StatefulWidget {
  const TournamentListScreen({super.key});

  @override
  State<TournamentListScreen> createState() => _TournamentListScreenState();
}

class _TournamentListScreenState extends State<TournamentListScreen> {
  bool _navigating = false;

  static const _brand = Color(0xFF0F766E);
  static const _bg = Color(0xFFF4F7F6);

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final userName = app.currentUser?.name ?? 'Referee';
    final firstName = userName.trim().split(RegExp(r'\s+')).first;

    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        title: const Column(
          children: [
            Text(
              'My Tournaments',
              style: TextStyle(
                fontWeight: FontWeight.w800,
                fontSize: 17,
                color: Color(0xFF0F172A),
              ),
            ),
            Text(
              'PPL Referee',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: Color(0xFF64748B),
              ),
            ),
          ],
        ),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF0F172A),
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        centerTitle: true,
      ),
      drawer: Drawer(
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            UserAccountsDrawerHeader(
              accountName: Text(
                userName,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              accountEmail: Text(app.currentUser?.email ?? ''),
              currentAccountPicture: CircleAvatar(
                backgroundColor: Colors.white,
                child: Text(
                  (firstName.isNotEmpty ? firstName[0] : 'R').toUpperCase(),
                  style: const TextStyle(
                    color: _brand,
                    fontWeight: FontWeight.w800,
                    fontSize: 22,
                  ),
                ),
              ),
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [Color(0xFF0F766E), Color(0xFF0B4A3E)],
                ),
              ),
            ),
            ListTile(
              leading: const Icon(Icons.person_outline, color: _brand),
              title: const Text('Profile'),
              onTap: () {
                Navigator.pop(context);
                Navigator.push(
                  context,
                  MaterialPageRoute(builder: (context) => const ProfileScreen()),
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
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: double.infinity,
            color: Colors.white,
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Hello, $firstName',
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                    color: Color(0xFF0F172A),
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  app.tournaments.isEmpty
                      ? 'No assigned tournaments yet'
                      : '${app.tournaments.length} tournament${app.tournaments.length == 1 ? '' : 's'} assigned to you',
                  style: const TextStyle(
                    fontSize: 13,
                    color: Color(0xFF64748B),
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              color: _brand,
              onRefresh: () => app.loadTournaments(),
              child: app.error != null
                  ? ListView(
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: [
                        SizedBox(height: MediaQuery.of(context).size.height * 0.2),
                        Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            children: [
                              Container(
                                width: 64,
                                height: 64,
                                decoration: BoxDecoration(
                                  color: Colors.red.shade50,
                                  shape: BoxShape.circle,
                                ),
                                child: Icon(Icons.error_outline, color: Colors.red.shade400, size: 30),
                              ),
                              const SizedBox(height: 16),
                              Text(
                                app.error!,
                                textAlign: TextAlign.center,
                                style: TextStyle(color: Colors.red.shade700, height: 1.4),
                              ),
                              const SizedBox(height: 16),
                              FilledButton(
                                onPressed: () => app.loadTournaments(),
                                style: FilledButton.styleFrom(
                                  backgroundColor: _brand,
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                ),
                                child: const Text('Retry'),
                              ),
                            ],
                          ),
                        ),
                      ],
                    )
                  : app.tournaments.isEmpty && !app.loading
                      ? ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          children: [
                            SizedBox(height: MediaQuery.of(context).size.height * 0.18),
                            const Center(
                              child: Column(
                                children: [
                                  Icon(Icons.emoji_events_outlined, color: Color(0xFF94A3B8), size: 48),
                                  SizedBox(height: 12),
                                  Text(
                                    'No tournaments found.',
                                    style: TextStyle(
                                      color: Color(0xFF64748B),
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                  SizedBox(height: 6),
                                  Text(
                                    'Pull down to refresh',
                                    style: TextStyle(color: Color(0xFF94A3B8), fontSize: 13),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        )
                      : ListView.separated(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
                          itemCount: app.tournaments.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 12),
                          itemBuilder: (_, i) {
                            final t = app.tournaments[i];
                            return Material(
                              color: Colors.transparent,
                              child: InkWell(
                                onTap: () async {
                                  if (_navigating) return;
                                  setState(() => _navigating = true);
                                  await app.selectTournament(t);
                                  if (!mounted) return;
                                  final nav = Navigator.of(context);
                                  await nav.pushNamed('/courtGames');
                                  if (mounted) setState(() => _navigating = false);
                                },
                                borderRadius: BorderRadius.circular(18),
                                child: Ink(
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    borderRadius: BorderRadius.circular(18),
                                    border: Border.all(
                                      color: _brand.withValues(alpha: 0.12),
                                    ),
                                    boxShadow: [
                                      BoxShadow(
                                        color: Colors.black.withValues(alpha: 0.04),
                                        blurRadius: 12,
                                        offset: const Offset(0, 4),
                                      ),
                                    ],
                                  ),
                                  child: IntrinsicHeight(
                                    child: Row(
                                      crossAxisAlignment: CrossAxisAlignment.stretch,
                                      children: [
                                        Container(
                                          width: 5,
                                          decoration: const BoxDecoration(
                                            color: _brand,
                                            borderRadius: BorderRadius.only(
                                              topLeft: Radius.circular(18),
                                              bottomLeft: Radius.circular(18),
                                            ),
                                          ),
                                        ),
                                        Expanded(
                                          child: Padding(
                                            padding: const EdgeInsets.fromLTRB(14, 16, 12, 16),
                                            child: Row(
                                              children: [
                                                Container(
                                                  width: 46,
                                                  height: 46,
                                                  decoration: BoxDecoration(
                                                    color: _brand.withValues(alpha: 0.1),
                                                    borderRadius: BorderRadius.circular(14),
                                                  ),
                                                  child: const Icon(
                                                    Icons.emoji_events_rounded,
                                                    color: _brand,
                                                    size: 24,
                                                  ),
                                                ),
                                                const SizedBox(width: 14),
                                                Expanded(
                                                  child: Column(
                                                    crossAxisAlignment: CrossAxisAlignment.start,
                                                    children: [
                                                      Text(
                                                        t.name,
                                                        style: const TextStyle(
                                                          fontSize: 15,
                                                          fontWeight: FontWeight.w700,
                                                          height: 1.3,
                                                          color: Color(0xFF0F172A),
                                                        ),
                                                      ),
                                                      const SizedBox(height: 6),
                                                      Container(
                                                        padding: const EdgeInsets.symmetric(
                                                          horizontal: 8,
                                                          vertical: 3,
                                                        ),
                                                        decoration: BoxDecoration(
                                                          color: const Color(0xFFECFDF5),
                                                          borderRadius: BorderRadius.circular(999),
                                                        ),
                                                        child: const Text(
                                                          'Open schedule',
                                                          style: TextStyle(
                                                            fontSize: 11,
                                                            fontWeight: FontWeight.w700,
                                                            color: _brand,
                                                          ),
                                                        ),
                                                      ),
                                                    ],
                                                  ),
                                                ),
                                                Container(
                                                  width: 32,
                                                  height: 32,
                                                  decoration: BoxDecoration(
                                                    color: const Color(0xFFF0FDFA),
                                                    borderRadius: BorderRadius.circular(10),
                                                  ),
                                                  child: const Icon(
                                                    Icons.arrow_forward_ios_rounded,
                                                    size: 14,
                                                    color: _brand,
                                                  ),
                                                ),
                                              ],
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            );
                          },
                        ),
            ),
          ),
        ],
      ),
    );
  }
}
