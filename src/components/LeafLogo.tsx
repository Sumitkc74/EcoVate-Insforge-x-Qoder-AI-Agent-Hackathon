/**
 * EcoVate brand mark: the same leaf used for the favicon (app/icon.svg),
 * so the logo in the header always matches the tab icon.
 */

export default function LeafLogo() {
  return (
    <div className="flex items-center space-x-2">
      <img src="/icon.svg" alt="Ecovate logo" className="w-8 h-8" />
      <span className="font-bold text-gray-900">Ecovate</span>
    </div>
  );
}
