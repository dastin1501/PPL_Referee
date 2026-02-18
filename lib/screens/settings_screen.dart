import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final user = app.currentUser;

    if (user == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Settings')),
        body: const Center(child: Text('User not found')),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Settings'),
        backgroundColor: Colors.teal.shade800,
        foregroundColor: Colors.white,
      ),
      backgroundColor: Colors.grey.shade50,
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header
            const Center(
              child: Padding(
                padding: EdgeInsets.only(bottom: 24.0),
                child: Column(
                  children: [
                    Text(
                      'Manage your profile information and account settings',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.grey, fontSize: 14),
                    ),
                  ],
                ),
              ),
            ),

            // Profile Information Section
            _buildSectionHeader('Profile Information', Icons.person),
            const SizedBox(height: 8),
            const Text(
              'View and update your personal information.',
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
            const SizedBox(height: 16),

            // Avatar Upload Card
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(color: Colors.grey.shade200),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 30,
                      backgroundColor: Colors.grey.shade200,
                      backgroundImage: user.avatarUrl != null ? NetworkImage(user.avatarUrl!) : null,
                      child: user.avatarUrl == null
                          ? Text(user.initials ?? '?', style: const TextStyle(fontSize: 24, color: Colors.grey))
                          : null,
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('AVATAR', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey)),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              OutlinedButton(
                                onPressed: () {},
                                style: OutlinedButton.styleFrom(
                                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                  side: BorderSide(color: Colors.grey.shade400),
                                ),
                                child: const Text('Choose File', style: TextStyle(color: Colors.black87, fontSize: 12)),
                              ),
                              const SizedBox(width: 8),
                              const Text('No file chosen', style: TextStyle(fontSize: 12, color: Colors.grey)),
                            ],
                          ),
                        ],
                      ),
                    ),
                    Column(
                      children: [
                        ElevatedButton(
                          onPressed: () {},
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.grey.shade600,
                            foregroundColor: Colors.white,
                            minimumSize: const Size(80, 36),
                          ),
                          child: const Text('UPLOAD', style: TextStyle(fontSize: 10)),
                        ),
                        const SizedBox(height: 4),
                        OutlinedButton(
                          onPressed: () {},
                          style: OutlinedButton.styleFrom(
                            backgroundColor: Colors.grey.shade600,
                            foregroundColor: Colors.white,
                            side: BorderSide.none,
                            minimumSize: const Size(80, 36),
                          ),
                          child: const Text('CANCEL', style: TextStyle(fontSize: 10)),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Read-only Fields (First/Last Name)
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(color: Colors.grey.shade200),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Row(
                  children: [
                    Expanded(
                      child: _buildReadOnlyField('FIRST NAME', user.name.split(' ').first),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: _buildReadOnlyField('LAST NAME', user.name.split(' ').length > 1 ? user.name.split(' ').last : ''),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Read-only Fields (Birthdate)
            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(color: Colors.grey.shade200),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: _buildReadOnlyField(
                  'BIRTHDATE AND AGE',
                  user.birthDate != null
                      ? '${user.birthDate!.toString().split(' ')[0]} (${_calculateAge(user.birthDate!)} years old)'
                      : 'N/A',
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Editable Fields
            _buildEditableCard('EMAIL ADDRESS', user.email, 'EDIT'),
            const SizedBox(height: 16),
            _buildEditableCard('PHONE NUMBER', '09687684383', 'EDIT'), // Hardcoded placeholder or user.phoneNumber
            const SizedBox(height: 16),
            _buildEditableCard('DUPR ID', user.duprId ?? 'N/A', 'EDIT',
                note: 'We\'re currently working with DUPR to implement the DUPR API...'),
            const SizedBox(height: 16),
            _buildEditableCard('LOCATION', '${user.city ?? ''}, ${user.country ?? ''}', 'EDIT'),

            const SizedBox(height: 40),

            // Change Password Section
            _buildSectionHeader('Change Password', Icons.lock),
            const SizedBox(height: 8),
            const Text(
              'Secure your account by updating your password. We\'ll send a one-time code to confirm.',
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
            const SizedBox(height: 16),

            Card(
              elevation: 0,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
                side: BorderSide(color: Colors.grey.shade200),
              ),
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // OTP Section
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          flex: 2,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text('ONE-TIME CODE (OTP)',
                                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey)),
                              const SizedBox(height: 4),
                              const Text(
                                'Click "Send OTP" to receive a code via email, then enter it below.',
                                style: TextStyle(fontSize: 10, color: Colors.grey, fontStyle: FontStyle.italic),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 8),
                        ElevatedButton(
                          onPressed: () {},
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.teal,
                            foregroundColor: Colors.white,
                          ),
                          child: const Text('SEND OTP'),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          flex: 1,
                          child: TextField(
                            decoration: InputDecoration(
                              hintText: 'Enter OTP',
                              contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                              border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 24),

                    // New Password Fields
                    const Text('NEW PASSWORD', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey)),
                    const SizedBox(height: 8),
                    TextField(
                      obscureText: true,
                      decoration: InputDecoration(
                        hintText: 'Enter new password',
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.blue.shade50,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: const Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('• At least 8 characters', style: TextStyle(fontSize: 11, color: Colors.blueGrey)),
                          Text('• One uppercase letter', style: TextStyle(fontSize: 11, color: Colors.blueGrey)),
                          Text('• One lowercase letter', style: TextStyle(fontSize: 11, color: Colors.blueGrey)),
                          Text('• One number', style: TextStyle(fontSize: 11, color: Colors.blueGrey)),
                          Text('• One special character (!@#\$%^&*)', style: TextStyle(fontSize: 11, color: Colors.blueGrey)),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),

                    const Text('CONFIRM NEW PASSWORD',
                        style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey)),
                    const SizedBox(height: 8),
                    TextField(
                      obscureText: true,
                      decoration: InputDecoration(
                        hintText: 'Confirm new password',
                        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                      ),
                    ),
                    const SizedBox(height: 24),

                    Row(
                      children: [
                        ElevatedButton(
                          onPressed: () {},
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.grey.shade600,
                            foregroundColor: Colors.white,
                          ),
                          child: const Text('UPDATE PASSWORD'),
                        ),
                        const SizedBox(width: 12),
                        ElevatedButton(
                          onPressed: () {},
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.grey.shade700,
                            foregroundColor: Colors.white,
                          ),
                          child: const Text('CANCEL'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),

            const SizedBox(height: 40),

            // Delete Account Section
            Row(
              children: [
                const Icon(Icons.warning, color: Colors.orange, size: 28),
                const SizedBox(width: 8),
                Text('Delete Account',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.red.shade700)),
              ],
            ),
            const Divider(color: Colors.red, thickness: 2, endIndent: 250), // Red underline
            const SizedBox(height: 8),
            const Text(
              'Archive your account. Your data is preserved but hidden from the site.',
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
            const SizedBox(height: 24),
            Center(
              child: ElevatedButton(
                onPressed: () {},
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red.shade700,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 12),
                ),
                child: const Text('DELETE MY ACCOUNT'),
              ),
            ),
            const SizedBox(height: 40),
          ],
        ),
      ),
    );
  }

  Widget _buildSectionHeader(String title, IconData icon) {
    return Row(
      children: [
        Icon(icon, color: Colors.purple.shade900, size: 24),
        const SizedBox(width: 8),
        Text(
          title,
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.black87),
        ),
      ],
    );
  }

  Widget _buildReadOnlyField(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey)),
        const SizedBox(height: 4),
        Text(value, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
        const SizedBox(height: 4),
        const Text('Not editable', style: TextStyle(fontSize: 10, color: Colors.grey, fontStyle: FontStyle.italic)),
      ],
    );
  }

  Widget _buildEditableCard(String label, String value, String btnLabel, {String? note}) {
    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: Colors.grey.shade200),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey)),
                    const SizedBox(height: 4),
                    Text(value, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                  ],
                ),
                ElevatedButton(
                  onPressed: () {},
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.teal,
                    foregroundColor: Colors.white,
                    minimumSize: const Size(60, 30),
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  ),
                  child: Text(btnLabel, style: const TextStyle(fontSize: 11)),
                ),
              ],
            ),
            if (note != null) ...[
              const SizedBox(height: 8),
              Text(note, style: const TextStyle(fontSize: 11, color: Colors.grey, fontStyle: FontStyle.italic)),
            ],
          ],
        ),
      ),
    );
  }

  int _calculateAge(DateTime birthDate) {
    final now = DateTime.now();
    int age = now.year - birthDate.year;
    if (now.month < birthDate.month || (now.month == birthDate.month && now.day < birthDate.day)) {
      age--;
    }
    return age;
  }
}
