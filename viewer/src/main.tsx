import { render } from 'preact';
import { App } from './App';
import './styles.css';

render(<App location={window.location} />, document.getElementById('app')!);
