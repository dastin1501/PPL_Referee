import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';

class CourtGamesScreen extends StatelessWidget {
  const CourtGamesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final courts = List<String>.from(app.courts)
      ..sort((a, b) {
        final ma = RegExp(r'(\d+)').firstMatch(a);
        final mb = RegExp(r'(\d+)').firstMatch(b);
        if (ma != null && mb != null) {
          final na = int.tryParse(ma.group(1)!) ?? 0;
          final nb = int.tryParse(mb.group(1)!) ?? 0;
          return na.compareTo(nb);
        }
        return a.toLowerCase().compareTo(b.toLowerCase());
      });
    final hasCourt = app.selectedCourt != null;
    final games = hasCourt ? app.matchesForSelectedCourt : [];
    final scheduledGames = games.where((g) => g.status != 'Completed').toList();
    final completedGames = games.where((g) => g.status == 'Completed').toList();

    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(app.selectedTournament?.name ?? 'Tournament'),
          backgroundColor: Colors.white,
          foregroundColor: Colors.black87,
          elevation: 0,
          bottom: const TabBar(
            indicatorColor: Color(0xFF22C55E),
            labelColor: Color(0xFF22C55E),
            unselectedLabelColor: Colors.grey,
            tabs: [
              Tab(text: 'Scheduled'),
              Tab(text: 'Completed'),
            ],
          ),
        ),
        body: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              if (courts.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(16.0),
                  child: Text('No courts found for this tournament.'),
                )
              else
                DropdownButtonFormField<String>(
                  value: app.selectedCourt,
                  items: courts
                      .map((c) => DropdownMenuItem<String>(
                            value: c,
                            child: Text(c),
                          ))
                      .toList(),
                  onChanged: (c) {
                    if (c != null) {
                      app.selectCourt(c);
                    }
                  },
                  decoration: InputDecoration(
                    labelText: 'Select Court',
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: BorderSide(color: Colors.grey.shade300),
                    ),
                    focusedBorder: const OutlineInputBorder(
                      borderRadius: BorderRadius.only(
                        topLeft: Radius.circular(14),
                        topRight: Radius.circular(14),
                        bottomLeft: Radius.circular(14),
                        bottomRight: Radius.circular(14),
                      ),
                      borderSide: BorderSide(color: Color(0xFF22C55E), width: 1.5),
                    ),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  ),
                ),
              const SizedBox(height: 12),
              Expanded(
                child: TabBarView(
                  children: [
                    _buildGamesList(context, app, scheduledGames, hasCourt, emptyMessage: 'No scheduled matches for this court.'),
                    _buildGamesList(context, app, completedGames, hasCourt, emptyMessage: 'No completed matches for this court.'),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

Widget _buildGamesList(
  BuildContext context,
  AppState app,
  List games,
  bool hasCourt, {
  required String emptyMessage,
}) {
  if (!hasCourt) {
    return const Center(child: Text('Please select a court to view matches.'));
  }
  if (games.isEmpty) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.event_busy, color: Colors.grey, size: 40),
          const SizedBox(height: 8),
          Text(emptyMessage, textAlign: TextAlign.center),
        ],
      ),
    );
  }
  return ListView.builder(
    itemCount: games.length,
    itemBuilder: (_, i) {
      final g = games[i];
      final category = app.selectedTournament?.categoryNames[g.categoryId] ?? '';
      final isCompleted = g.status == 'Completed';
      return InkWell(
        onTap: () {
          if (isCompleted) {
            _showCompletedSummaryDialog(context, g);
          } else {
            app.openGame(g);
            Navigator.of(context).pushNamed('/dashboard');
          }
        },
        borderRadius: BorderRadius.circular(16),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: Colors.grey.shade300),
          ),
          child: Row(
            children: [
              CircleAvatar(
                backgroundColor: isCompleted ? const Color(0xFF22C55E) : Colors.orange,
                child: Icon(isCompleted ? Icons.check : Icons.schedule, color: Colors.white, size: 20),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (category.isNotEmpty)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          border: Border.all(color: const Color(0xFF22C55E)),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(category, style: const TextStyle(fontSize: 12, color: Color(0xFF22C55E))),
                      ),
                    if (g.matchLabel.isNotEmpty || g.seedLabel.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2.0),
                        child: Text(
                          '${g.matchLabel} ${g.seedLabel.isNotEmpty ? "- ${g.seedLabel}" : ""}',
                          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                        ),
                      ),
                    Text('${g.player1} vs ${g.player2}', style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500)),
                    Text('Time: ${g.time}', style: const TextStyle(fontSize: 12, color: Colors.grey)),
                  ],
                ),
              ),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text('${g.score1} - ${g.score2}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  if (g.status.isNotEmpty) Text(g.status, style: const TextStyle(fontSize: 10, color: Colors.grey)),
                ],
              ),
            ],
          ),
        ),
      );
    },
  );
}

void _showCompletedSummaryDialog(BuildContext context, dynamic g) {
  final int s1 = g.score1;
  final int s2 = g.score2;
  final String winnerName = (g.winner?.toString()?.isNotEmpty ?? false)
      ? g.winner.toString()
      : (s1 > s2 ? g.player1 : (s2 > s1 ? g.player2 : ''));
  String? sig = g.signatureData;
  if ((sig == null || sig.isEmpty) && g.gameSignatures is List && g.gameSignatures.isNotEmpty) {
    final first = g.gameSignatures.first;
    if (first is String && first.isNotEmpty) sig = first;
  }
  Uint8List? bytes;
  if (sig != null && sig.isNotEmpty) {
    try {
      final String cleaned = sig.startsWith('data:image') ? sig.split(',').last : sig;
      bytes = base64Decode(cleaned);
    } catch (_) {}
  }
  showDialog(
    context: context,
    barrierDismissible: true,
    builder: (_) {
      return AlertDialog(
        title: const Text('Match Summary'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${g.player1} vs ${g.player2}'),
              const SizedBox(height: 8),
              Text('Final Score: $s1 - $s2', style: const TextStyle(fontWeight: FontWeight.bold)),
              if (winnerName.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text('Winner: $winnerName'),
              ],
              const SizedBox(height: 16),
              const Text('Signature', style: TextStyle(color: Colors.grey)),
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                height: 220,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  border: Border.all(color: Colors.black12),
                ),
                child: bytes != null
                    ? Image.memory(bytes, fit: BoxFit.contain, width: double.infinity, height: double.infinity)
                    : const Text('No signature available'),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
        ],
      );
    },
  );
}
