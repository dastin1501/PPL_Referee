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
    return SliverAppBar(
      expandedHeight: 200.0,
      floating: false,
      pinned: true,
      flexibleSpace: FlexibleSpaceBar(
        background: Stack(
          fit: StackFit.expand,
          children: [
            // Cover Photo Pattern
            Container(
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [Colors.blueAccent, Colors.tealAccent],
                ),
              ),
              child: Opacity(
                opacity: 0.1,
                child: Image.network(
                  'https://www.transparenttextures.com/patterns/cubes.png', // Subtle pattern
                  repeat: ImageRepeat.repeat,
                ),
              ),
            ),
            // Profile Avatar (Overlapping)
            Positioned(
              bottom: 0,
              left: 20,
              child: Transform.translate(
                offset: const Offset(0, 50),
                child: CircleAvatar(
                  radius: 54,
                  backgroundColor: Colors.white,
                  child: CircleAvatar(
                    radius: 50,
                    backgroundColor: Colors.teal,
                    backgroundImage: user.avatarUrl != null ? NetworkImage(user.avatarUrl!) : null,
                    child: user.avatarUrl == null
                        ? Text(
                            user.initials ?? (user.name.isNotEmpty ? user.name[0].toUpperCase() : '?'),
                            style: const TextStyle(fontSize: 40, color: Colors.white),
                          )
                        : null,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildProfileHeader(User user) {
    // Calculate Age
    String age = 'N/A';
    if (user.birthDate != null) {
      final now = DateTime.now();
      final difference = now.difference(user.birthDate!);
      age = '${(difference.inDays / 365).floor()} Years';
    }

    return Padding(
      padding: const EdgeInsets.only(top: 40.0), // Space for overlapping avatar
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            user.name,
            style: const TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: Colors.black87),
          ),
          const SizedBox(height: 16),
          
          // Stats Row (PPL ID, DUPR ID, RATINGS)
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _buildStatItem('PPL ID', user.pplId ?? 'N/A'),
                const SizedBox(width: 24),
                _buildStatItem('DUPR ID', user.duprId ?? 'N/A'),
                const SizedBox(width: 24),
                _buildStatItem('DUPR SINGLES', user.singlesRating?.toString() ?? 'NR'),
                const SizedBox(width: 24),
                _buildStatItem('DUPR DOUBLES', user.doublesRating?.toString() ?? 'NR'),
                const SizedBox(width: 24),
                _buildStatItem('AGE', age),
                const SizedBox(width: 24),
                _buildStatItem('GENDER', user.gender ?? 'N/A'),
              ],
            ),
          ),
        ],
      ),
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
            labelColor: Colors.teal,
            unselectedLabelColor: Colors.grey,
            indicatorColor: Colors.teal,
            tabs: [
              Tab(text: 'About'),
              Tab(text: 'My Club'),
              Tab(text: 'Tournaments'),
            ],
          ),
          const SizedBox(height: 24),
          SizedBox(
            height: 400, // Fixed height for tab content
            child: TabBarView(
              children: [
                // About Tab
                SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Bio',
                        style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.teal),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        user.bio ?? 'No bio provided.',
                        style: const TextStyle(fontSize: 16, color: Colors.black87, height: 1.5),
                      ),
                      const SizedBox(height: 16),
                      OutlinedButton.icon(
                        onPressed: () {
                          // Edit Bio Logic
                          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Edit Bio coming soon')));
                        },
                        icon: const Icon(Icons.edit, size: 16, color: Colors.teal),
                        label: const Text('Edit', style: TextStyle(color: Colors.teal)),
                      ),
                    ],
                  ),
                ),
                
                // My Club Tab (Placeholder)
                const Center(child: Text('Club information not available')),
                
                // Tournaments Tab (Placeholder)
                const Center(child: Text('No past tournaments found')),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
