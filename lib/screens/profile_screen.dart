import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';
import '../models.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final user = app.currentUser;

    if (user == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Profile')),
        body: const Center(child: Text('User not found')),
      );
    }

    return Scaffold(
      backgroundColor: Colors.white,
      body: CustomScrollView(
        slivers: [
          _buildSliverAppBar(user),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildProfileHeader(user),
                  const SizedBox(height: 24),
                  _buildTabs(context, user),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSliverAppBar(User user) {
    return const SliverAppBar(
      toolbarHeight: 56.0,
      floating: false,
      pinned: true,
      backgroundColor: Colors.white,
      foregroundColor: Colors.black87,
      elevation: 0,
    );
  }

  Widget _buildProfileHeader(User user) {
    String age = 'N/A';
    if (user.birthDate != null) {
      final now = DateTime.now();
      final difference = now.difference(user.birthDate!);
      age = '${(difference.inDays / 365).floor()} Years';
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Container(
              width: 96,
              height: 96,
              decoration: const BoxDecoration(
                shape: BoxShape.circle,
                gradient: LinearGradient(
                  colors: [Color.fromARGB(255, 26, 161, 123), Color.fromARGB(255, 26, 161, 123)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
              ),
              child: ClipOval(
                child: user.avatarUrl != null
                    ? Image.network(user.avatarUrl!, fit: BoxFit.cover)
                    : Center(
                        child: Text(
                          user.initials ?? (user.name.isNotEmpty ? user.name[0].toUpperCase() : '?'),
                          style: const TextStyle(fontSize: 36, color: Colors.white, fontWeight: FontWeight.bold),
                        ),
                      ),
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(user.name, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  Text(user.email ?? '', style: const TextStyle(color: Colors.grey)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 20),
        Column(
          children: [
            Row(
              children: [
                Expanded(child: _buildStatItem('PPL ID', user.pplId ?? 'N/A')),
                const SizedBox(width: 12),
                Expanded(child: _buildStatItem('AGE', age)),
                const SizedBox(width: 12),
                Expanded(child: _buildStatItem('GENDER', user.gender ?? 'N/A')),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(child: _buildStatItem('DUPR ID', user.duprId ?? 'N/A')),
                const SizedBox(width: 12),
                Expanded(child: _buildStatItem('DUPR SINGLES', user.singlesRating?.toString() ?? 'NR')),
                const SizedBox(width: 12),
                Expanded(child: _buildStatItem('DUPR DOUBLES', user.doublesRating?.toString() ?? 'NR')),
              ],
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildStatItem(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Colors.grey),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.black87),
        ),
      ],
    );
  }

  Widget _buildTabs(BuildContext context, User user) {
    return DefaultTabController(
      length: 3,
      child: Column(
        children: [
          const TabBar(
            labelColor: Color.fromARGB(255, 26, 161, 123),
            unselectedLabelColor: Colors.grey,
            indicatorColor: Color.fromARGB(255, 26, 161, 123),
            tabs: [
              Tab(text: 'About'),
              Tab(text: 'My Club'),
              Tab(text: 'Tournaments'),
            ],
          ),
          const SizedBox(height: 24),
          SizedBox(
            height: 400,
            child: TabBarView(
              children: [
                SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Bio',
                        style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color.fromARGB(255, 26, 161, 123)),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        user.bio ?? 'No bio provided.',
                        style: const TextStyle(fontSize: 16, color: Colors.black87, height: 1.5),
                      ),
                      const SizedBox(height: 16),
                      OutlinedButton.icon(
                        onPressed: () {
                          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Edit Bio coming soon')));
                        },
                        icon: const Icon(Icons.edit, size: 16, color: Color.fromARGB(255, 26, 161, 123)),
                        label: const Text('Edit', style: TextStyle(color: Color.fromARGB(255, 26, 161, 123))),
                      ),
                    ],
                  ),
                ),
                
                const Center(child: Text('Club information not available')),
                
                const Center(child: Text('No past tournaments found')),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
