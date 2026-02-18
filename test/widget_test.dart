import 'package:flutter_test/flutter_test.dart';

import 'package:referee_mobile_app/main.dart';

void main() {
  testWidgets('App boots to login screen', (WidgetTester tester) async {
    await tester.pumpWidget(const RefereeApp());
    await tester.pumpAndSettle();
    expect(find.text('Referee Login'), findsOneWidget);
  });
}
