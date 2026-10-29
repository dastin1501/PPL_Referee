import 'package:flutter/material.dart';

/// Short fade + slight slide used for referee navigation.
Route<T> smoothPageRoute<T>({
  required WidgetBuilder builder,
  RouteSettings? settings,
  Duration duration = const Duration(milliseconds: 220),
}) {
  return PageRouteBuilder<T>(
    settings: settings,
    transitionDuration: duration,
    reverseTransitionDuration: duration,
    pageBuilder: (context, animation, secondaryAnimation) => builder(context),
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
        reverseCurve: Curves.easeInCubic,
      );
      return FadeTransition(
        opacity: curved,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0.04, 0),
            end: Offset.zero,
          ).animate(curved),
          child: child,
        ),
      );
    },
  );
}
