import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';

/// Non-blocking global sync chip — never interrupts scoring.
class GlobalSyncIndicator extends StatelessWidget {
  const GlobalSyncIndicator({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final pendingMatches = app.pendingScoreSyncMatchCount;
    final connected = app.socketConnected;
    final stale = app.scoreSyncHasStale;

    if (pendingMatches <= 0 && connected && !stale) {
      return const SizedBox.shrink();
    }

    final label = stale
        ? (pendingMatches > 0
            ? '$pendingMatches match${pendingMatches == 1 ? '' : 'es'} sync delayed'
            : 'Sync delayed')
        : pendingMatches > 0
            ? '$pendingMatches match${pendingMatches == 1 ? '' : 'es'} syncing'
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
              ],
            ),
          ),
        ),
      ),
    );
  }
}
