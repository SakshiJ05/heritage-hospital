// Common home-collection tests offered as the starter catalog. Rates are starter
// values only: Admin can edit them for the clinic. Syncing is insert-only, so a
// rate/category/disabled state already changed in Admin is never overwritten.
const STANDARD_TESTS = [
  // Haematology
  ['CBC (Complete Blood Count)', 'Haematology', 300],
  ['Haemoglobin (Hb)', 'Haematology', 120],
  ['ESR (Erythrocyte Sedimentation Rate)', 'Haematology', 180],
  ['Peripheral Blood Smear', 'Haematology', 250],
  ['Platelet Count', 'Haematology', 180],
  ['Reticulocyte Count', 'Haematology', 250],
  ['Blood Group & Rh Typing', 'Haematology', 150],
  ['Bleeding Time & Clotting Time (BT/CT)', 'Coagulation', 250],
  ['Prothrombin Time / INR (PT/INR)', 'Coagulation', 400],
  ['APTT', 'Coagulation', 450],
  ['D-Dimer', 'Coagulation', 900],

  // Diabetes
  ['Blood Sugar (Fasting)', 'Diabetes', 150],
  ['Blood Sugar (PP)', 'Diabetes', 150],
  ['Blood Sugar (Random)', 'Diabetes', 150],
  ['HbA1c', 'Diabetes', 450],
  ['Insulin (Fasting)', 'Diabetes', 700],

  // Liver
  ['Liver Function Test (LFT)', 'Liver Profile', 600],
  ['Bilirubin (Total, Direct & Indirect)', 'Liver Profile', 300],
  ['SGOT / AST', 'Liver Profile', 220],
  ['SGPT / ALT', 'Liver Profile', 220],
  ['Alkaline Phosphatase (ALP)', 'Liver Profile', 220],
  ['Gamma GT (GGT)', 'Liver Profile', 450],
  ['Total Protein, Albumin & Globulin', 'Liver Profile', 350],
  ['Albumin', 'Liver Profile', 200],

  // Kidney and electrolytes
  ['Kidney Function Test (KFT)', 'Kidney Profile', 600],
  ['Blood Urea', 'Kidney Profile', 180],
  ['Serum Creatinine', 'Kidney Profile', 180],
  ['Uric Acid', 'Kidney Profile', 220],
  ['Electrolyte Panel (Na, K, Cl)', 'Kidney Profile', 450],
  ['Sodium', 'Electrolytes', 180],
  ['Potassium', 'Electrolytes', 180],
  ['Calcium', 'Electrolytes', 220],
  ['Phosphorus', 'Electrolytes', 220],
  ['Magnesium', 'Electrolytes', 350],

  // Lipids and cardiac markers
  ['Lipid Profile', 'Lipid Profile', 500],
  ['Total Cholesterol', 'Lipid Profile', 180],
  ['Triglycerides', 'Lipid Profile', 220],
  ['HDL Cholesterol', 'Lipid Profile', 220],
  ['LDL Cholesterol', 'Lipid Profile', 220],
  ['Troponin I', 'Cardiac Marker', 900],
  ['CK-MB', 'Cardiac Marker', 650],
  ['BNP / NT-proBNP', 'Cardiac Marker', 1800],
  ['High-Sensitivity CRP (hs-CRP)', 'Cardiac Marker', 700],

  // Thyroid and hormones
  ['Thyroid Profile (T3 T4 TSH)', 'Thyroid Profile', 650],
  ['TSH', 'Thyroid Profile', 300],
  ['Free T3 (FT3)', 'Thyroid Profile', 350],
  ['Free T4 (FT4)', 'Thyroid Profile', 350],
  ['Beta hCG', 'Hormone', 550],
  ['FSH', 'Hormone', 550],
  ['LH', 'Hormone', 550],
  ['Prolactin', 'Hormone', 550],
  ['Testosterone', 'Hormone', 700],
  ['PSA (Total)', 'Tumour Marker', 800],

  // Vitamins, iron and inflammation
  ['Vitamin D (25-OH)', 'Vitamin', 1200],
  ['Vitamin B12', 'Vitamin', 900],
  ['Folate', 'Vitamin', 900],
  ['Iron Profile', 'Iron Studies', 700],
  ['Serum Iron', 'Iron Studies', 300],
  ['Ferritin', 'Iron Studies', 550],
  ['CRP (C-Reactive Protein)', 'Inflammation', 450],
  ['Rheumatoid Factor (RA Factor)', 'Inflammation', 450],
  ['ASO Titre', 'Inflammation', 450],

  // Infection and fever
  ['Dengue NS1 Antigen', 'Fever Profile', 700],
  ['Dengue IgM & IgG', 'Fever Profile', 900],
  ['Malaria Parasite', 'Fever Profile', 300],
  ['Malaria Antigen', 'Fever Profile', 550],
  ['Widal Test', 'Fever Profile', 300],
  ['Typhidot IgM', 'Fever Profile', 650],
  ['HBsAg (Hepatitis B)', 'Serology', 450],
  ['Anti-HCV', 'Serology', 650],
  ['HIV 1 & 2', 'Serology', 500],
  ['VDRL', 'Serology', 300],

  // Urine, stool and cultures
  ['Urine Routine & Microscopy', 'Urine Test', 180],
  ['Urine Culture & Sensitivity', 'Microbiology', 700],
  ['Urine Microalbumin / Creatinine Ratio', 'Urine Test', 650],
  ['24-Hour Urine Protein', 'Urine Test', 450],
  ['Stool Routine & Microscopy', 'Stool Test', 200],
  ['Stool Occult Blood', 'Stool Test', 300],
  ['Blood Culture & Sensitivity', 'Microbiology', 1100],

  // Pancreas and general chemistry
  ['Amylase', 'Pancreatic Profile', 450],
  ['Lipase', 'Pancreatic Profile', 550],
  ['LDH (Lactate Dehydrogenase)', 'Biochemistry', 450],

  // Non-lab services already offered by the clinic
  ['Chest X-Ray', 'Radiology', 400],
  ['ECG', 'Cardiology', 300],
].map(([name, category, amount]) => ({ name, category, amount }));

async function syncStandardTests(TestCatalog) {
  const existing = await TestCatalog.find().select('name').lean();
  const names = new Set(existing.map(test => test.name.trim().toLocaleLowerCase('en-IN')));
  const missing = STANDARD_TESTS.filter(test => !names.has(test.name.toLocaleLowerCase('en-IN')));
  if (missing.length) await TestCatalog.insertMany(missing);
  return { added: missing.length, total: await TestCatalog.countDocuments() };
}

module.exports = { STANDARD_TESTS, syncStandardTests };
