'use strict';

// Seeds example checkpoints so you can try the system immediately.
// Run once with: npm run seed
// Replace/rename them on the admin Checkpoints page to match your school.

const { listCheckpoints, addCheckpoint } = require('./src/db');

const EXAMPLE_CHECKPOINTS = [
  ['Main entrance', 'Ground floor'],
  ['Back entrance', 'Ground floor'],
  ['Gym', 'Ground floor'],
  ['Cafeteria', 'Ground floor'],
  ['Library', '1st floor'],
  ['Computer lab', '1st floor'],
  ['Chemistry lab', '2nd floor'],
  ['Physics lab', '2nd floor'],
  ['Stairwell A', 'Each floor'],
  ['Stairwell B', 'Each floor'],
  ['Boiler room', 'Basement'],
  ['Schoolyard gate', 'Outside'],
  ['Parking lot', 'Outside'],
  ['Sports field', 'Outside'],
  ['Roof access door', 'Top floor'],
];

async function main() {
  if ((await listCheckpoints()).length > 0) {
    console.log('Checkpoints already exist — nothing seeded.');
    process.exit(0);
  }

  for (const [name, location] of EXAMPLE_CHECKPOINTS) {
    const cp = await addCheckpoint(name, location);
    console.log(`Added ${cp.id}  ${name} (${location})`);
  }
  console.log(`\nSeeded ${EXAMPLE_CHECKPOINTS.length} checkpoints. Open /admin/tags to get the URLs to write to your NFC tags.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
