import { Link } from 'react-router-dom';
import { PageHead } from '../components/ui';

export function NotFound() {
  return (
    <div className="page">
      <PageHead title="Not found" lead="That page does not exist in the console." />
      <p>
        <Link to="/" className="btn btn-primary">
          Back to the landing page
        </Link>
      </p>
    </div>
  );
}
