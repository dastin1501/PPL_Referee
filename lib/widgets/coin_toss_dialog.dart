import 'dart:math';
import 'package:flutter/material.dart';

class CoinTossDialog extends StatefulWidget {
  final String player1;
  final String player2;

  const CoinTossDialog({
    super.key,
    required this.player1,
    required this.player2,
  });

  @override
  State<CoinTossDialog> createState() => _CoinTossDialogState();
}

class _CoinTossDialogState extends State<CoinTossDialog> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  bool _isFlipping = false;
  String? _result; // 'Heads' or 'Tails'

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(seconds: 2),
      vsync: this,
    );
  }

  void _flipCoin() {
    setState(() {
      _isFlipping = true;
      _result = null;
    });
    _controller.forward(from: 0).then((_) {
      setState(() {
        _isFlipping = false;
        _result = Random().nextBool() ? 'Heads' : 'Tails';
      });
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Center(child: Text('Coin Toss')),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AnimatedBuilder(
              animation: _controller,
              builder: (context, child) {
                final value = _controller.value;
                final angle = value * pi * 10;
                return Transform(
                  transform: Matrix4.identity()
                    ..setEntry(3, 2, 0.001)
                    ..rotateX(angle),
                  alignment: Alignment.center,
                  child: Container(
                    width: 100,
                    height: 100,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: Colors.amber,
                      border: Border.all(color: Colors.orange, width: 4),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withOpacity(0.3),
                          blurRadius: 8,
                          offset: const Offset(0, 4),
                        ),
                      ],
                    ),
                    child: Center(
                      child: _isFlipping
                          ? const Icon(Icons.loop, size: 40, color: Colors.white)
                          : Text(
                              _result ?? '?',
                              style: const TextStyle(
                                fontSize: 22,
                                fontWeight: FontWeight.bold,
                                color: Colors.white,
                              ),
                            ),
                    ),
                  ),
                );
              },
            ),
            const SizedBox(height: 16),
            if (!_isFlipping && _result == null)
              ElevatedButton.icon(
                onPressed: _flipCoin,
                icon: const Icon(Icons.casino),
                label: const Text('Flip Coin'),
              ),
            if (_result != null) ...[
              Text(
                'Result: $_result',
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Colors.blueGrey),
              ),
            ],
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
  }
}
