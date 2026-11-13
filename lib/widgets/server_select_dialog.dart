import 'package:flutter/material.dart';

class ServerSelectResult {
  const ServerSelectResult({
    required this.servingPlayer,
    required this.endsSwitched,
    this.receivingPlayer,
  });

  final String servingPlayer;
  final bool endsSwitched;
  /// Receiving player on the opposite team (doubles). Null for singles.
  final String? receivingPlayer;
}

/// Post coin-toss: pick opening server, then (doubles) the other team's receiver.
class ServerSelectDialog extends StatefulWidget {
  const ServerSelectDialog({
    super.key,
    required this.team1Players,
    required this.team2Players,
    this.team1Label = 'Team 1',
    this.team2Label = 'Team 2',
    this.initialEndsSwitched = false,
    this.initialServer,
    this.initialReceiver,
  });

  final List<String> team1Players;
  final List<String> team2Players;
  final String team1Label;
  final String team2Label;
  final bool initialEndsSwitched;
  final String? initialServer;
  final String? initialReceiver;

  @override
  State<ServerSelectDialog> createState() => _ServerSelectDialogState();
}

enum _SelectStep { server, receiver }

class _ServerSelectDialogState extends State<ServerSelectDialog> {
  static const _brand = Color(0xFF0F766E);
  static const _brandSoft = Color(0xFF0D9488);
  static const _bg = Color(0xFFF4F7F6);
  static const _panel = Colors.white;
  static const _cardTop = Color(0xFFECFDF5);

  late bool _endsSwitched;
  _SelectStep _step = _SelectStep.server;
  String? _selectedServer;
  String? _selectedReceiver;

  @override
  void initState() {
    super.initState();
    _endsSwitched = widget.initialEndsSwitched;
    _selectedServer = widget.initialServer;
    _selectedReceiver = widget.initialReceiver;
  }

  List<String> get _team1 =>
      widget.team1Players.where((e) => e.trim().isNotEmpty).toList();
  List<String> get _team2 =>
      widget.team2Players.where((e) => e.trim().isNotEmpty).toList();

  List<String> get _leftPlayers => _endsSwitched ? _team2 : _team1;
  List<String> get _rightPlayers => _endsSwitched ? _team1 : _team2;
  String get _leftLabel =>
      _endsSwitched ? widget.team2Label : widget.team1Label;
  String get _rightLabel =>
      _endsSwitched ? widget.team1Label : widget.team2Label;

  bool get _isDoubles => _team1.length > 1 || _team2.length > 1;

  /// Opposite team from the chosen server (display-agnostic, by roster).
  List<String> get _receivingTeamPlayers {
    final server = (_selectedServer ?? '').trim();
    if (server.isEmpty) return const [];
    if (_team1.contains(server)) return _team2;
    if (_team2.contains(server)) return _team1;
    return const [];
  }

  String get _receivingTeamLabel {
    final server = (_selectedServer ?? '').trim();
    if (_team1.contains(server)) return widget.team2Label;
    if (_team2.contains(server)) return widget.team1Label;
    return 'Receiving team';
  }

  bool get _needsReceiverStep =>
      _isDoubles && _receivingTeamPlayers.length > 1;

  String _shortName(String raw) {
    final name = raw.trim();
    if (name.isEmpty) return name;
    final parts = name.split(RegExp(r'\s+')).where((e) => e.isNotEmpty).toList();
    if (parts.length == 1) return parts.first;
    final first = parts.first;
    final last = parts.last;
    final initial = last.isNotEmpty ? '${last[0]}.' : '';
    return '$first $initial'.trim();
  }

  void _finish({required String server, String? receiver}) {
    Navigator.of(context).pop(
      ServerSelectResult(
        servingPlayer: server,
        endsSwitched: _endsSwitched,
        receivingPlayer: receiver,
      ),
    );
  }

  void _onPrimary() {
    if (_step == _SelectStep.server) {
      final server = (_selectedServer ?? '').trim();
      if (server.isEmpty) return;
      if (_needsReceiverStep) {
        // Drop a stale receiver if they are no longer on the opposite team.
        final recv = (_selectedReceiver ?? '').trim();
        setState(() {
          _step = _SelectStep.receiver;
          if (recv.isNotEmpty && !_receivingTeamPlayers.contains(recv)) {
            _selectedReceiver = null;
          }
        });
        return;
      }
      _finish(server: server);
      return;
    }

    final server = (_selectedServer ?? '').trim();
    final receiver = (_selectedReceiver ?? '').trim();
    if (server.isEmpty || receiver.isEmpty) return;
    _finish(server: server, receiver: receiver);
  }

  void _goBackToServer() {
    setState(() => _step = _SelectStep.server);
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final wide = size.width >= 700;
    final pickingServer = _step == _SelectStep.server;
    final title =
        pickingServer ? 'Who is the server?' : 'Who is the receiver?';
    final subtitle = pickingServer
        ? 'Tap a player, or switch sides to match the court.'
        : 'Tap the receiving player on the other team.';
    final primaryLabel = pickingServer
        ? ((_selectedServer ?? '').trim().isEmpty
            ? 'Select a server'
            : (_needsReceiverStep ? 'Next: pick receiver' : 'Confirm server'))
        : ((_selectedReceiver ?? '').trim().isEmpty
            ? 'Select a receiver'
            : 'Confirm receiver');
    final primaryEnabled = pickingServer
        ? (_selectedServer ?? '').trim().isNotEmpty
        : (_selectedReceiver ?? '').trim().isNotEmpty;

    final viewPadding = MediaQuery.paddingOf(context);
    final maxDialogHeight =
        (size.height - viewPadding.vertical - 24).clamp(280.0, size.height);

    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      backgroundColor: _bg,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: wide ? 860 : 520,
          maxHeight: maxDialogHeight,
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  if (!pickingServer)
                    IconButton(
                      onPressed: _goBackToServer,
                      icon: const Icon(Icons.arrow_back_rounded,
                          color: Color(0xFF64748B)),
                      tooltip: 'Back',
                    ),
                  Expanded(
                    child: Text(
                      title,
                      style: const TextStyle(
                        color: Color(0xFF0F172A),
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close, color: Color(0xFF64748B)),
                  ),
                ],
              ),
              // Cap middle so the confirm button always stays fully visible.
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: (maxDialogHeight - 150).clamp(120.0, maxDialogHeight),
                ),
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          subtitle,
                          style: const TextStyle(
                            color: Color(0xFF64748B),
                            fontSize: 13,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      if (!pickingServer &&
                          (_selectedServer ?? '').trim().isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'Server: ${_shortName(_selectedServer!)}',
                            style: const TextStyle(
                              color: _brand,
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: 10),
                      if (pickingServer)
                        LayoutBuilder(
                          builder: (context, c) {
                            final landscape = c.maxWidth >= 620;
                            final left = _TeamPanel(
                              label: _leftLabel,
                              players: _leftPlayers,
                              selected: _selectedServer,
                              shortName: _shortName,
                              onSelect: (name) =>
                                  setState(() => _selectedServer = name),
                            );
                            final right = _TeamPanel(
                              label: _rightLabel,
                              players: _rightPlayers,
                              selected: _selectedServer,
                              shortName: _shortName,
                              onSelect: (name) =>
                                  setState(() => _selectedServer = name),
                            );
                            final vs = _VsSwitch(
                              endsSwitched: _endsSwitched,
                              onSwitch: () => setState(
                                () => _endsSwitched = !_endsSwitched,
                              ),
                            );

                            if (landscape) {
                              return Row(
                                crossAxisAlignment: CrossAxisAlignment.center,
                                children: [
                                  Expanded(child: left),
                                  Padding(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 10,
                                    ),
                                    child: vs,
                                  ),
                                  Expanded(child: right),
                                ],
                              );
                            }
                            return Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                left,
                                Padding(
                                  padding: const EdgeInsets.symmetric(
                                    vertical: 12,
                                  ),
                                  child: vs,
                                ),
                                right,
                              ],
                            );
                          },
                        )
                      else
                        _TeamPanel(
                          label: _receivingTeamLabel,
                          players: _receivingTeamPlayers,
                          selected: _selectedReceiver,
                          shortName: _shortName,
                          onSelect: (name) =>
                              setState(() => _selectedReceiver = name),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: primaryEnabled ? _onPrimary : null,
                  style: FilledButton.styleFrom(
                    backgroundColor: _brand,
                    disabledBackgroundColor: _brand.withValues(alpha: 0.35),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  child: Text(
                    primaryLabel,
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _VsSwitch extends StatelessWidget {
  const _VsSwitch({
    required this.endsSwitched,
    required this.onSwitch,
  });

  final bool endsSwitched;
  final VoidCallback onSwitch;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Text(
          'VS',
          style: TextStyle(
            color: Color(0xFF0F766E),
            fontWeight: FontWeight.w900,
            fontSize: 22,
            letterSpacing: 1.2,
          ),
        ),
        const SizedBox(height: 10),
        Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: onSwitch,
            borderRadius: BorderRadius.circular(999),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFF0F766E).withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(999),
                border: Border.all(
                  color: const Color(0xFF0F766E).withValues(alpha: 0.35),
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.compare_arrows_rounded,
                    size: 18,
                    color: endsSwitched
                        ? const Color(0xFF0F766E)
                        : const Color(0xFF0D9488),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    endsSwitched ? 'Sides switched' : 'Switch sides',
                    style: const TextStyle(
                      color: Color(0xFF0F766E),
                      fontWeight: FontWeight.w700,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _TeamPanel extends StatelessWidget {
  const _TeamPanel({
    required this.label,
    required this.players,
    required this.selected,
    required this.shortName,
    required this.onSelect,
  });

  final String label;
  final List<String> players;
  final String? selected;
  final String Function(String) shortName;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final list = players.where((e) => e.trim().isNotEmpty).toList();
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: _ServerSelectDialogState._panel,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFF0F766E).withValues(alpha: 0.15)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 10,
            offset: const Offset(0, 3),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Color(0xFF64748B),
              fontWeight: FontWeight.w700,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 8),
          if (list.isEmpty)
            const SizedBox(
              height: 120,
              child: Center(
                child: Text(
                  'No players',
                  style: TextStyle(color: Color(0xFF94A3B8)),
                ),
              ),
            )
          else
            SizedBox(
              height: 108,
              child: Row(
                children: [
                  for (var i = 0; i < list.length; i++) ...[
                    if (i > 0) const SizedBox(width: 8),
                    Expanded(
                      child: _PlayerCard(
                        name: list[i],
                        displayName: shortName(list[i]),
                        selected: selected == list[i],
                        onTap: () => onSelect(list[i]),
                      ),
                    ),
                  ],
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _PlayerCard extends StatelessWidget {
  const _PlayerCard({
    required this.name,
    required this.displayName,
    required this.selected,
    required this.onTap,
  });

  final String name;
  final String displayName;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final border = selected
        ? _ServerSelectDialogState._brand
        : const Color(0xFFCBD5E1);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: border, width: selected ? 2 : 1),
          ),
          child: Column(
            children: [
              Expanded(
                child: ColoredBox(
                  color: _ServerSelectDialogState._cardTop,
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      const Center(
                        child: Icon(
                          Icons.person_rounded,
                          size: 42,
                          color: Color(0xFF0F766E),
                        ),
                      ),
                      if (selected)
                        const Positioned(
                          top: 6,
                          right: 6,
                          child: CircleAvatar(
                            radius: 11,
                            backgroundColor: Color(0xFF0F766E),
                            child: Icon(
                              Icons.check_rounded,
                              size: 14,
                              color: Colors.white,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
                color: selected
                    ? _ServerSelectDialogState._brand
                    : _ServerSelectDialogState._brandSoft,
                child: Text(
                  displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w800,
                    fontSize: 12,
                    height: 1.1,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
