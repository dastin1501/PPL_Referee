import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/score_event_queue.dart';
import '../state/app_state.dart';

/// Non-blocking global sync chip — never interrupts scoring.
/// Tap opens a panel with pending matches and Retry.
class GlobalSyncIndicator extends StatelessWidget {
  const GlobalSyncIndicator({super.key});

  @override
  Widget build(BuildContext context) {
    final pendingMatches =
        context.select<AppState, int>((a) => a.pendingScoreSyncMatchCount);
    final connected = context.select<AppState, bool>((a) => a.socketConnected);
    final stale = context.select<AppState, bool>((a) => a.scoreSyncHasStale);

    if (pendingMatches <= 0 && connected && !stale) {
      return const SizedBox.shrink();
    }

    final label = stale
        ? (pendingMatches > 0
            ? '$pendingMatches match${pendingMatches == 1 ? '' : 'es'} sync delayed · Tap'
            : 'Sync delayed · Tap')
        : pendingMatches > 0
            ? '$pendingMatches match${pendingMatches == 1 ? '' : 'es'} syncing · Tap'
            : 'Reconnecting…';

    final bg = stale
        ? const Color(0xFF7F1D1D)
        : connected
            ? const Color(0xFF134E4A)
            : const Color(0xFF78350F);

    return SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(20),
            onTap: () => showScoreSyncPanel(context),
            child: Container(
              margin: const EdgeInsets.only(top: 6),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: bg.withValues(alpha: 0.92),
                borderRadius: BorderRadius.circular(20),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.2),
                    blurRadius: 8,
                    offset: const Offset(0, 2),
                  ),
                ],
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: connected && !stale
                          ? const Color(0xFF34D399)
                          : stale
                              ? const Color(0xFFFCA5A5)
                              : const Color(0xFFFBBF24),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    label,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Icon(
                    Icons.refresh_rounded,
                    size: 14,
                    color: Colors.white.withValues(alpha: 0.85),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Shared sync panel — also used from the referee dashboard chip.
Future<void> showScoreSyncPanel(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: const Color(0xFFF8FAFC),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (ctx) => const _ScoreSyncSheet(),
  );
}

class _ScoreSyncSheet extends StatefulWidget {
  const _ScoreSyncSheet();

  @override
  State<_ScoreSyncSheet> createState() => _ScoreSyncSheetState();
}

class _ScoreSyncSheetState extends State<_ScoreSyncSheet> {
  bool _retryingAll = false;
  String? _retryingMatch;

  Future<void> _retryAll(AppState app) async {
    setState(() => _retryingAll = true);
    try {
      await app.retryScoreSync();
    } finally {
      if (mounted) setState(() => _retryingAll = false);
    }
  }

  Future<void> _retryOne(AppState app, String matchIdentity) async {
    setState(() => _retryingMatch = matchIdentity);
    try {
      await app.retryScoreSync(matchIdentity: matchIdentity);
    } finally {
      if (mounted) setState(() => _retryingMatch = null);
    }
  }

  String _ageLabel(Duration d) {
    if (d.inMinutes >= 1) return '${d.inMinutes}m ago';
    return '${d.inSeconds}s ago';
  }

  String _shortError(String? raw) {
    if (raw == null || raw.trim().isEmpty) return 'Waiting for server';
    final t = raw.trim();
    if (t.length <= 90) return t;
    return '${t.substring(0, 87)}…';
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final rows = app.pendingScoreSyncMatches;
    final connected = app.socketConnected;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: const Color(0xFFCBD5E1),
                  borderRadius: BorderRadius.circular(99),
                ),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                const Expanded(
                  child: Text(
                    'Score sync',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w800,
                      color: Color(0xFF0F172A),
                    ),
                  ),
                ),
                Text(
                  connected ? 'Online' : 'Offline',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: connected
                        ? const Color(0xFF0F766E)
                        : const Color(0xFFB45309),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            const Text(
              'Other courts keep scoring while a slow match retries in the background.',
              style: TextStyle(
                fontSize: 13,
                color: Color(0xFF64748B),
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 14),
            if (rows.isEmpty)
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: const Color(0xFFE2E8F0)),
                ),
                child: const Text(
                  'All matches are synced.',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: Color(0xFF0F766E),
                    fontWeight: FontWeight.w700,
                  ),
                ),
              )
            else
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * 0.45,
                ),
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: rows.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 8),
                  itemBuilder: (context, i) {
                    final row = rows[i];
                    return _PendingMatchTile(
                      row: row,
                      ageLabel: _ageLabel(row.oldestAge),
                      errorLabel: _shortError(row.lastError),
                      busy: _retryingMatch == row.matchIdentity || _retryingAll,
                      onRetry: () => unawaited(_retryOne(app, row.matchIdentity)),
                    );
                  },
                ),
              ),
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: rows.isEmpty || _retryingAll
                  ? null
                  : () => unawaited(_retryAll(app)),
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFF0F766E),
                disabledBackgroundColor:
                    const Color(0xFF0F766E).withValues(alpha: 0.35),
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              icon: _retryingAll
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Icon(Icons.refresh_rounded, size: 18),
              label: Text(
                _retryingAll ? 'Retrying…' : 'Retry all pending',
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PendingMatchTile extends StatelessWidget {
  const _PendingMatchTile({
    required this.row,
    required this.ageLabel,
    required this.errorLabel,
    required this.busy,
    required this.onRetry,
  });

  final ScoreSyncPendingMatch row;
  final String ageLabel;
  final String errorLabel;
  final bool busy;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: row.stale ? const Color(0xFFFECACA) : const Color(0xFFE2E8F0),
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: row.stale
                  ? const Color(0xFFEF4444)
                  : const Color(0xFFF59E0B),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  row.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 14,
                    color: Color(0xFF0F172A),
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  [
                    '${row.pendingCount} event${row.pendingCount == 1 ? '' : 's'}',
                    ageLabel,
                    if (row.waitingSubmit) 'submit',
                    if (row.stale) 'delayed',
                  ].join(' · '),
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF64748B),
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  errorLabel,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    color: row.stale
                        ? const Color(0xFFB91C1C)
                        : const Color(0xFF94A3B8),
                  ),
                ),
              ],
            ),
          ),
          TextButton(
            onPressed: busy ? null : onRetry,
            child: busy
                ? const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text(
                    'Retry',
                    style: TextStyle(
                      fontWeight: FontWeight.w800,
                      color: Color(0xFF0F766E),
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
